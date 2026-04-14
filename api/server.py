"""FastAPI server that launches run_swebench and streams progress to the frontend."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = ROOT / "workspace"
EVENTS_FILE = WORKSPACE / "events.jsonl"
TASKS_DIR = WORKSPACE / "tasks"
CLONES_DIR = WORKSPACE / "clones"
PREDICTIONS_FILE = WORKSPACE / "predictions.jsonl"
RUNNER_LOG = WORKSPACE / "runner.log"
EVAL_ROOT = WORKSPACE / "evaluate"
EVAL_LOG = WORKSPACE / "evaluate.log"
RUNNER = ROOT / "run_swebench.py"

_event_lock = threading.Lock()


def _emit_event(event: dict) -> None:
    event.setdefault("ts", time.time())
    line = json.dumps(event, ensure_ascii=False) + "\n"
    with _event_lock, EVENTS_FILE.open("a", encoding="utf-8") as fh:
        fh.write(line)
        fh.flush()

TREE_IGNORE_DIRS = {".git", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", "node_modules", ".venv", "venv", ".tox"}
MAX_TREE_ENTRIES = 20000

WORKSPACE.mkdir(exist_ok=True)
TASKS_DIR.mkdir(exist_ok=True)

app = FastAPI(title="square-bench live")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

state: dict[str, Optional[subprocess.Popen]] = {"proc": None}
eval_state: dict = {"proc": None, "run_id": None, "watcher": None, "report": None}


class StartRequest(BaseModel):
    dataset: str = "princeton-nlp/SWE-bench_Lite"
    split: str = "test"
    limit: int = 3
    agent: str = "deepwork-headless"
    timeout: int = 1800


def _is_running() -> bool:
    proc = state["proc"]
    return proc is not None and proc.poll() is None


@app.get("/api/status")
async def status():
    proc = state["proc"]
    return {
        "running": _is_running(),
        "pid": proc.pid if proc else None,
        "returncode": proc.returncode if proc and proc.poll() is not None else None,
    }


@app.post("/api/start")
async def start(req: StartRequest):
    if _is_running():
        raise HTTPException(status_code=409, detail="A run is already in progress")

    EVENTS_FILE.write_text("")
    RUNNER_LOG.write_text("")
    # Clear stale outputs from previous runs so the UI starts fresh.
    import shutil
    for parent in (TASKS_DIR, CLONES_DIR):
        if parent.exists():
            for d in parent.iterdir():
                if d.is_dir():
                    shutil.rmtree(d, ignore_errors=True)

    cmd = [
        sys.executable,
        "-u",
        str(RUNNER),
        "--dataset", req.dataset,
        "--split", req.split,
        "--limit", str(req.limit),
        "--agent", req.agent,
        "--timeout", str(req.timeout),
        "--events", str(EVENTS_FILE),
        "--tasks-dir", str(TASKS_DIR),
        "--output", str(PREDICTIONS_FILE),
    ]
    log_fh = open(RUNNER_LOG, "ab", buffering=0)
    proc = subprocess.Popen(
        cmd,
        cwd=ROOT,
        stdin=subprocess.DEVNULL,
        stdout=log_fh,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    state["proc"] = proc
    return {"status": "started", "pid": proc.pid}


@app.post("/api/stop")
async def stop():
    proc = state["proc"]
    if not proc or proc.poll() is not None:
        return {"status": "not running"}
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    return {"status": "stopped"}


async def _tail_events(request: Request):
    pos = 0
    buf = b""
    # Replay existing content first so late subscribers see the whole run.
    while True:
        if await request.is_disconnected():
            return
        try:
            size = EVENTS_FILE.stat().st_size
        except FileNotFoundError:
            size = 0

        if size < pos:
            # File was truncated (new run) — restart.
            pos = 0
            buf = b""

        if size > pos:
            with EVENTS_FILE.open("rb") as f:
                f.seek(pos)
                chunk = f.read(size - pos)
                pos = size
            buf += chunk
            *lines, buf = buf.split(b"\n")
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                yield f"data: {line.decode('utf-8', 'replace')}\n\n"
        else:
            await asyncio.sleep(0.15)
            yield ": keep-alive\n\n"


@app.get("/api/events")
async def events(request: Request):
    return StreamingResponse(
        _tail_events(request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/tasks")
async def list_tasks():
    tasks = []
    if TASKS_DIR.exists():
        for d in sorted(TASKS_DIR.iterdir()):
            if d.is_dir():
                tasks.append(d.name)
    return {"tasks": tasks}


def _safe_join(base: Path, rel: str) -> Path:
    base = base.resolve()
    full = (base / rel).resolve()
    if full != base and not str(full).startswith(str(base) + "/"):
        raise HTTPException(status_code=400, detail="invalid path")
    return full


@app.get("/api/tasks/{instance_id}/files")
async def task_files(instance_id: str):
    diffs_root = TASKS_DIR / instance_id / "diffs"
    if not diffs_root.exists():
        return {"files": []}
    files = []
    for p in sorted(diffs_root.rglob("*.diff")):
        if p.is_file():
            rel = str(p.relative_to(diffs_root))
            files.append(rel[:-5])  # strip ".diff"
    return {"files": files}


@app.get("/api/tasks/{instance_id}/file", response_class=PlainTextResponse)
async def task_file(instance_id: str, path: str):
    full = _safe_join(TASKS_DIR / instance_id / "files", path)
    if not full.is_file():
        raise HTTPException(status_code=404, detail="not found")
    try:
        return full.read_text()
    except UnicodeDecodeError:
        return PlainTextResponse("<binary file>")


@app.get("/api/tasks/{instance_id}/diff", response_class=PlainTextResponse)
async def task_diff(instance_id: str, path: str):
    full = _safe_join(TASKS_DIR / instance_id / "diffs", path + ".diff")
    if not full.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return full.read_text()


@app.get("/api/tasks/{instance_id}/tree")
async def task_tree(instance_id: str):
    clone_root = CLONES_DIR / instance_id
    if not clone_root.exists():
        return {"ready": False, "paths": []}
    paths: list[str] = []
    truncated = False
    for dirpath, dirnames, filenames in os.walk(clone_root):
        # Prune ignored dirs in place so os.walk skips them.
        dirnames[:] = [d for d in dirnames if d not in TREE_IGNORE_DIRS]
        rel_dir = Path(dirpath).relative_to(clone_root)
        for name in filenames:
            rel = (rel_dir / name).as_posix()
            if rel.startswith("./"):
                rel = rel[2:]
            paths.append(rel)
            if len(paths) >= MAX_TREE_ENTRIES:
                truncated = True
                break
        if truncated:
            break
    paths.sort()
    return {"ready": True, "paths": paths, "truncated": truncated}


@app.get("/api/tasks/{instance_id}/source", response_class=PlainTextResponse)
async def task_source(instance_id: str, path: str):
    full = _safe_join(CLONES_DIR / instance_id, path)
    if not full.is_file():
        raise HTTPException(status_code=404, detail="not found")
    try:
        if full.stat().st_size > 2 * 1024 * 1024:
            return PlainTextResponse("<file too large to display>")
        return full.read_text()
    except UnicodeDecodeError:
        return PlainTextResponse("<binary file>")


@app.get("/api/log", response_class=PlainTextResponse)
async def runner_log():
    if not RUNNER_LOG.exists():
        return ""
    data = RUNNER_LOG.read_bytes()
    if len(data) > 64 * 1024:
        data = data[-64 * 1024:]
    return data.decode("utf-8", "replace")


@app.get("/api/state")
async def state_snapshot():
    events: list[dict] = []
    if EVENTS_FILE.exists():
        for line in EVENTS_FILE.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return {
        "running": _is_running(),
        "events": events,
    }


class EvaluateRequest(BaseModel):
    dataset: str = "SWE-bench/SWE-bench_Lite"
    split: str = "test"
    model_name: str = "squarecode"
    workers: int = 4
    timeout: int = 1800
    cache_level: str = "env"


def _eval_running() -> bool:
    p = eval_state["proc"]
    return p is not None and p.poll() is None


def _collect_instance_reports(run_id: str, model_name: str) -> dict[str, dict]:
    """Scan swebench's log output for per-instance report.json files."""
    run_dir = EVAL_ROOT / "logs" / "run_evaluation" / run_id / model_name
    results: dict[str, dict] = {}
    if not run_dir.exists():
        return results
    for inst_dir in run_dir.iterdir():
        if not inst_dir.is_dir():
            continue
        report_path = inst_dir / "report.json"
        if not report_path.exists():
            continue
        try:
            data = json.loads(report_path.read_text())
        except Exception:
            continue
        if isinstance(data, dict) and inst_dir.name in data:
            results[inst_dir.name] = data[inst_dir.name]
        else:
            results[inst_dir.name] = data
    return results


def _summarize(reports: dict[str, dict]) -> dict:
    total = len(reports)
    resolved = sum(1 for r in reports.values() if r.get("resolved"))
    applied = sum(1 for r in reports.values() if r.get("patch_successfully_applied"))
    empty = sum(1 for r in reports.values() if r.get("patch_is_None"))
    return {
        "total": total,
        "resolved": resolved,
        "applied": applied,
        "empty_patch": empty,
        "resolved_rate": (resolved / total) if total else 0.0,
        "apply_rate": (applied / total) if total else 0.0,
    }


def _watch_evaluation(proc: subprocess.Popen, run_id: str, model_name: str) -> None:
    seen: set[str] = set()
    run_dir = EVAL_ROOT / "logs" / "run_evaluation" / run_id / model_name
    while proc.poll() is None:
        if run_dir.exists():
            for inst_dir in run_dir.iterdir():
                if not inst_dir.is_dir() or inst_dir.name in seen:
                    continue
                report_path = inst_dir / "report.json"
                if not report_path.exists():
                    continue
                try:
                    data = json.loads(report_path.read_text())
                    result = data.get(inst_dir.name, data) if isinstance(data, dict) else {}
                except Exception as e:
                    _emit_event({
                        "type": "evaluate_instance",
                        "instance_id": inst_dir.name,
                        "error": f"report parse failed: {e}",
                    })
                    seen.add(inst_dir.name)
                    continue
                seen.add(inst_dir.name)
                _emit_event({
                    "type": "evaluate_instance",
                    "instance_id": inst_dir.name,
                    "resolved": bool(result.get("resolved")),
                    "patch_applied": bool(result.get("patch_successfully_applied")),
                    "patch_is_none": bool(result.get("patch_is_None")),
                    "tests_status": result.get("tests_status"),
                })
        time.sleep(1.5)

    # Final sweep after exit.
    reports = _collect_instance_reports(run_id, model_name)
    for iid, r in reports.items():
        if iid in seen:
            continue
        seen.add(iid)
        _emit_event({
            "type": "evaluate_instance",
            "instance_id": iid,
            "resolved": bool(r.get("resolved")),
            "patch_applied": bool(r.get("patch_successfully_applied")),
            "patch_is_none": bool(r.get("patch_is_None")),
            "tests_status": r.get("tests_status"),
        })

    summary = _summarize(reports)
    eval_state["report"] = {"run_id": run_id, "summary": summary, "instances": reports}
    _emit_event({
        "type": "evaluate_done",
        "run_id": run_id,
        "returncode": proc.returncode,
        "summary": summary,
    })


@app.post("/api/evaluate")
async def evaluate_start(req: EvaluateRequest):
    if _eval_running():
        raise HTTPException(status_code=409, detail="Evaluation already running")
    if not PREDICTIONS_FILE.exists() or PREDICTIONS_FILE.stat().st_size == 0:
        raise HTTPException(status_code=400, detail="No predictions.jsonl to evaluate")

    run_id = f"sq-{int(time.time())}"
    EVAL_ROOT.mkdir(parents=True, exist_ok=True)
    EVAL_LOG.write_text("")

    cmd = [
        sys.executable, "-m", "swebench.harness.run_evaluation",
        "-p", str(PREDICTIONS_FILE),
        "-d", req.dataset,
        "-s", req.split,
        "-id", run_id,
        "--max_workers", str(req.workers),
        "--timeout", str(req.timeout),
        "--cache_level", req.cache_level,
    ]
    log_fh = open(EVAL_LOG, "ab", buffering=0)
    proc = subprocess.Popen(
        cmd,
        cwd=EVAL_ROOT,
        stdin=subprocess.DEVNULL,
        stdout=log_fh,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    eval_state["proc"] = proc
    eval_state["run_id"] = run_id
    eval_state["report"] = None

    watcher = threading.Thread(
        target=_watch_evaluation,
        args=(proc, run_id, req.model_name),
        daemon=True,
    )
    watcher.start()
    eval_state["watcher"] = watcher

    _emit_event({
        "type": "evaluate_start",
        "run_id": run_id,
        "dataset": req.dataset,
        "split": req.split,
        "model_name": req.model_name,
    })
    return {"status": "started", "run_id": run_id, "pid": proc.pid}


@app.post("/api/evaluate/stop")
async def evaluate_stop():
    p = eval_state["proc"]
    if not p or p.poll() is not None:
        return {"status": "not running"}
    p.terminate()
    try:
        p.wait(timeout=5)
    except subprocess.TimeoutExpired:
        p.kill()
    return {"status": "stopped"}


@app.get("/api/evaluate/status")
async def evaluate_status():
    p = eval_state["proc"]
    return {
        "running": _eval_running(),
        "run_id": eval_state.get("run_id"),
        "returncode": p.returncode if p and p.poll() is not None else None,
        "report": eval_state.get("report"),
    }


@app.get("/api/evaluate/log", response_class=PlainTextResponse)
async def evaluate_log():
    if not EVAL_LOG.exists():
        return ""
    data = EVAL_LOG.read_bytes()
    if len(data) > 128 * 1024:
        data = data[-128 * 1024:]
    return data.decode("utf-8", "replace")


@app.get("/api/predictions")
async def predictions():
    if not PREDICTIONS_FILE.exists():
        return {"records": []}
    records = []
    for line in PREDICTIONS_FILE.read_text().splitlines():
        if line.strip():
            records.append(json.loads(line))
    return {"records": records}

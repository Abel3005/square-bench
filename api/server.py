"""FastAPI server that launches run_swebench and streams progress to the frontend."""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
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
PREDICTIONS_FILE = WORKSPACE / "predictions.jsonl"
RUNNER_LOG = WORKSPACE / "runner.log"
RUNNER = ROOT / "run_swebench.py"

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
    # Clear the tasks dir so stale outputs from previous runs don't confuse the UI.
    if TASKS_DIR.exists():
        for d in TASKS_DIR.iterdir():
            if d.is_dir():
                import shutil
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


@app.get("/api/predictions")
async def predictions():
    if not PREDICTIONS_FILE.exists():
        return {"records": []}
    records = []
    for line in PREDICTIONS_FILE.read_text().splitlines():
        if line.strip():
            records.append(json.loads(line))
    return {"records": records}

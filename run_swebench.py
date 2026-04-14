"""Run squarecode against SWE-bench instances with live events and per-task file snapshots."""

import argparse
import json
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

from datasets import load_dataset

PROMPT_TEMPLATE = """You are fixing a real bug in {repo} at commit {base_commit}.

<problem_statement>
{problem_statement}
</problem_statement>

Work in the current directory (already checked out at the base commit).
Edit the source files to resolve the problem. Do not commit.
When done, exit.
"""

EXCLUDE_PREFIXES = (".event-tracker/", ".event-tracker")


class EventSink:
    def __init__(self, path: Optional[Path]):
        self._fh = path.open("a", buffering=1) if path else None
        self._lock = threading.Lock()

    def emit(self, **event) -> None:
        event.setdefault("ts", time.time())
        line = json.dumps(event, ensure_ascii=False)
        with self._lock:
            if self._fh:
                self._fh.write(line + "\n")
                self._fh.flush()
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def close(self) -> None:
        if self._fh:
            self._fh.close()


def clone_instance(repo: str, base_commit: str, dest: Path) -> None:
    url = f"https://github.com/{repo}.git"
    subprocess.run(["git", "clone", "--quiet", url, str(dest)], check=True)
    subprocess.run(["git", "-C", str(dest), "checkout", "--quiet", base_commit], check=True)


def run_squarecode_stream(
    workdir: Path,
    prompt: str,
    agent: Optional[str],
    timeout: int,
    instance_id: str,
    sink: EventSink,
) -> int:
    cmd = ["squarecode", "run"]
    if agent:
        cmd.append(f"--agent={agent}")
    cmd.append(prompt)

    proc = subprocess.Popen(
        cmd,
        cwd=workdir,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    def pump() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            sink.emit(
                type="agent_stdout",
                instance_id=instance_id,
                line=line.rstrip("\n"),
            )

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        reader.join(timeout=2)
        raise
    reader.join(timeout=5)
    return proc.returncode or 0


def save_task_files(workdir: Path, tasks_dir: Path, instance_id: str, sink: EventSink) -> list[str]:
    result = subprocess.run(
        ["git", "-C", str(workdir), "status", "--porcelain", "-uall"],
        capture_output=True,
        text=True,
        check=True,
    )
    out_dir = tasks_dir / instance_id
    saved: list[str] = []

    for raw in result.stdout.splitlines():
        if not raw:
            continue
        status = raw[:2]
        path = raw[3:]
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        path = path.strip().strip('"')
        if not path or any(path.startswith(p) for p in EXCLUDE_PREFIXES):
            continue
        if "D" in status and not (workdir / path).exists():
            continue

        src = workdir / path
        if not src.is_file():
            continue
        dst = out_dir / path
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        saved.append(path)
        sink.emit(type="file_saved", instance_id=instance_id, path=path)

    return saved


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="princeton-nlp/SWE-bench_Lite")
    parser.add_argument("--split", default="test")
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--agent", default="deepwork-headless")
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--output", type=Path, default=Path("predictions.jsonl"))
    parser.add_argument("--tasks-dir", type=Path, default=Path("workspace/tasks"))
    parser.add_argument("--events", type=Path, default=None)
    parser.add_argument("--model-name", default="squarecode")
    args = parser.parse_args()

    args.tasks_dir.mkdir(parents=True, exist_ok=True)
    sink = EventSink(args.events)

    try:
        sink.emit(
            type="run_start",
            dataset=args.dataset,
            split=args.split,
            limit=args.limit,
            agent=args.agent,
        )

        ds = load_dataset(args.dataset, split=args.split)
        if args.limit:
            ds = ds.select(range(min(args.limit, len(ds))))

        with args.output.open("w") as f:
            for row in ds:
                instance_id = row["instance_id"]
                repo = row["repo"]
                base_commit = row["base_commit"]

                sink.emit(
                    type="instance_start",
                    instance_id=instance_id,
                    repo=repo,
                    base_commit=base_commit,
                )

                workdir = args.tasks_dir.parent / "clones" / instance_id
                if workdir.exists():
                    shutil.rmtree(workdir)
                workdir.parent.mkdir(parents=True, exist_ok=True)

                error: Optional[str] = None
                saved: list[str] = []

                try:
                    sink.emit(type="clone_start", instance_id=instance_id)
                    clone_instance(repo, base_commit, workdir)
                    sink.emit(type="clone_done", instance_id=instance_id)

                    prompt = PROMPT_TEMPLATE.format(
                        repo=repo,
                        base_commit=base_commit,
                        problem_statement=row["problem_statement"],
                    )

                    sink.emit(type="agent_start", instance_id=instance_id)
                    rc = run_squarecode_stream(
                        workdir, prompt, args.agent, args.timeout, instance_id, sink
                    )
                    sink.emit(type="agent_done", instance_id=instance_id, returncode=rc)
                    if rc != 0:
                        error = f"squarecode exited {rc}"

                    saved = save_task_files(workdir, args.tasks_dir, instance_id, sink)
                except subprocess.TimeoutExpired:
                    error = "timeout"
                except subprocess.CalledProcessError as e:
                    error = f"subprocess failed: {e}"
                except Exception as e:  # noqa: BLE001
                    error = f"{type(e).__name__}: {e}"
                finally:
                    shutil.rmtree(workdir, ignore_errors=True)

                record = {
                    "instance_id": instance_id,
                    "model_name_or_path": args.model_name,
                    "files": saved,
                }
                if error:
                    record["error"] = error
                f.write(json.dumps(record) + "\n")
                f.flush()

                sink.emit(
                    type="instance_done",
                    instance_id=instance_id,
                    error=error,
                    files=saved,
                )

        sink.emit(type="run_done")
    finally:
        sink.close()


if __name__ == "__main__":
    main()

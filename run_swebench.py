"""Run squarecode against SWE-bench instances with live events and per-task file snapshots."""

import argparse
import json
import os
import shutil
import signal
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

_stop_requested = threading.Event()
_current_agent: dict[str, Optional[subprocess.Popen]] = {"proc": None}
_current_container: dict[str, Optional[str]] = {"name": None}

DEFAULT_DOCKER_IMAGE = "square-bench/squarecode:latest"


def _install_signal_handlers() -> None:
    def handler(signum, _frame):
        _stop_requested.set()
        proc = _current_agent["proc"]
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
        name = _current_container["name"]
        if name:
            try:
                subprocess.run(["docker", "kill", name], check=False,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception:
                pass

    signal.signal(signal.SIGTERM, handler)
    signal.signal(signal.SIGINT, handler)


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
    _current_agent["proc"] = proc

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
    _current_agent["proc"] = None
    return proc.returncode or 0


def _docker_config_mounts() -> list[str]:
    """Read-only mounts for squarecode auth/config from the host user."""
    home = Path(os.path.expanduser("~"))
    candidates = [
        (home / ".local/share/squarecode/auth.json",
         "/root/.local/share/squarecode/auth.json"),
        (home / ".config/squarecode/squarecode.json",
         "/root/.config/squarecode/squarecode.json"),
        (home / ".local/state/squarecode/model.json",
         "/root/.local/state/squarecode/model.json"),
    ]
    args: list[str] = []
    for src, dst in candidates:
        if src.exists():
            args += ["-v", f"{src}:{dst}:ro"]
    return args


def run_in_container(
    workdir: Path,
    repo: str,
    base_commit: str,
    prompt: str,
    agent: Optional[str],
    timeout: int,
    instance_id: str,
    image: str,
    sink: EventSink,
) -> int:
    """Clone + run squarecode entirely inside a container, bind-mounting workdir.

    Files created by the container appear on the host at `workdir`, so the
    existing save_task_files() pipeline keeps working unchanged.
    """
    workdir.mkdir(parents=True, exist_ok=True)
    prompt_file = workdir.parent / f".prompt-{instance_id}.txt"
    prompt_file.write_text(prompt)

    container_name = f"sb-{instance_id}-{int(time.time())}"
    _current_container["name"] = container_name

    agent_flag = f" --agent={agent}" if agent else ""
    script = (
        "set -e\n"
        f'git clone --quiet "https://github.com/{repo}.git" /work\n'
        f'git -C /work checkout --quiet "{base_commit}"\n'
        'cd /work\n'
        f'squarecode run{agent_flag} "$(cat /prompt.txt)"\n'
    )

    cmd = [
        "docker", "run", "--rm", "-i",
        "--name", container_name,
        "-v", f"{workdir.resolve()}:/work",
        "-v", f"{prompt_file.resolve()}:/prompt.txt:ro",
        *_docker_config_mounts(),
        "-w", "/work",
        "--entrypoint", "bash",
        image,
        "-lc", script,
    ]

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    _current_agent["proc"] = proc

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
        subprocess.run(["docker", "kill", container_name], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        proc.kill()
        reader.join(timeout=2)
        raise
    finally:
        prompt_file.unlink(missing_ok=True)
        _current_agent["proc"] = None
        _current_container["name"] = None

    reader.join(timeout=5)
    return proc.returncode or 0


def save_task_files(workdir: Path, tasks_dir: Path, instance_id: str, sink: EventSink) -> tuple[list[str], str]:
    # Intent-to-add untracked files so `git diff` reports them as additions.
    subprocess.run(
        ["git", "-C", str(workdir), "add", "-N", "--", ".",
         ":(exclude).event-tracker", ":(exclude).event-tracker/**"],
        check=False,
    )
    listing = subprocess.run(
        ["git", "-C", str(workdir), "diff", "--name-only", "--",
         ".", ":(exclude).event-tracker", ":(exclude).event-tracker/**"],
        capture_output=True,
        text=True,
        check=True,
    )
    full_patch_proc = subprocess.run(
        ["git", "-C", str(workdir), "diff", "--",
         ".", ":(exclude).event-tracker", ":(exclude).event-tracker/**"],
        capture_output=True,
        text=True,
        check=True,
    )
    full_patch = full_patch_proc.stdout

    out_dir = tasks_dir / instance_id
    files_dir = out_dir / "files"
    diffs_dir = out_dir / "diffs"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "model_patch.diff").write_text(full_patch)
    saved: list[str] = []

    for path in listing.stdout.splitlines():
        path = path.strip()
        if not path or any(path.startswith(p) for p in EXCLUDE_PREFIXES):
            continue

        diff_proc = subprocess.run(
            ["git", "-C", str(workdir), "diff", "--", path],
            capture_output=True,
            text=True,
            check=True,
        )
        diff_text = diff_proc.stdout
        diff_path = diffs_dir / (path + ".diff")
        diff_path.parent.mkdir(parents=True, exist_ok=True)
        diff_path.write_text(diff_text)

        src = workdir / path
        if src.is_file():
            dst = files_dir / path
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)

        saved.append(path)
        added = sum(1 for line in diff_text.splitlines() if line.startswith("+") and not line.startswith("+++"))
        removed = sum(1 for line in diff_text.splitlines() if line.startswith("-") and not line.startswith("---"))
        sink.emit(
            type="file_saved",
            instance_id=instance_id,
            path=path,
            added=added,
            removed=removed,
        )

    return saved, full_patch


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
    parser.add_argument("--runner", choices=["host", "docker"], default="host",
                        help="Where to run squarecode: directly on host or inside a container.")
    parser.add_argument("--docker-image", default=DEFAULT_DOCKER_IMAGE,
                        help="Image used when --runner=docker.")
    args = parser.parse_args()

    args.tasks_dir.mkdir(parents=True, exist_ok=True)
    sink = EventSink(args.events)
    _install_signal_handlers()

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

        task_manifest = [
            {
                "instance_id": row["instance_id"],
                "repo": row["repo"],
                "base_commit": row["base_commit"],
            }
            for row in ds
        ]
        sink.emit(type="tasks_created", tasks=task_manifest)

        with args.output.open("w") as f:
            for row in ds:
                if _stop_requested.is_set():
                    break

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
                model_patch: str = ""
                cloned = False

                try:
                    prompt = PROMPT_TEMPLATE.format(
                        repo=repo,
                        base_commit=base_commit,
                        problem_statement=row["problem_statement"],
                    )

                    if args.runner == "docker":
                        sink.emit(type="clone_start", instance_id=instance_id,
                                  runner="docker", image=args.docker_image)
                        sink.emit(type="agent_start", instance_id=instance_id,
                                  runner="docker")
                        rc = run_in_container(
                            workdir, repo, base_commit, prompt, args.agent,
                            args.timeout, instance_id, args.docker_image, sink,
                        )
                        cloned = workdir.exists() and any(workdir.iterdir())
                        sink.emit(type="clone_done", instance_id=instance_id)
                    else:
                        sink.emit(type="clone_start", instance_id=instance_id)
                        clone_instance(repo, base_commit, workdir)
                        cloned = True
                        sink.emit(type="clone_done", instance_id=instance_id)

                        sink.emit(type="agent_start", instance_id=instance_id)
                        rc = run_squarecode_stream(
                            workdir, prompt, args.agent, args.timeout, instance_id, sink
                        )
                    sink.emit(type="agent_done", instance_id=instance_id, returncode=rc)
                    if rc != 0:
                        error = f"squarecode exited {rc}"
                    if _stop_requested.is_set():
                        error = "stopped"
                except subprocess.TimeoutExpired:
                    error = "timeout"
                except subprocess.CalledProcessError as e:
                    error = f"subprocess failed: {e}"
                except Exception as e:  # noqa: BLE001
                    error = f"{type(e).__name__}: {e}"
                finally:
                    if cloned:
                        try:
                            saved, model_patch = save_task_files(
                                workdir, args.tasks_dir, instance_id, sink
                            )
                        except Exception as e:  # noqa: BLE001
                            sink.emit(
                                type="agent_stdout",
                                instance_id=instance_id,
                                line=f"[save_task_files failed: {e}]",
                            )
                    # Clone is kept so the UI can browse the full repo; it is
                    # wiped at the next /api/start.

                record = {
                    "instance_id": instance_id,
                    "model_name_or_path": args.model_name,
                    "model_patch": model_patch,
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

                if _stop_requested.is_set():
                    break

        sink.emit(type="run_done", stopped=_stop_requested.is_set())
    finally:
        sink.close()


if __name__ == "__main__":
    main()

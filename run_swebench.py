"""Run squarecode against SWE-bench instances and emit a predictions file."""

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from datasets import load_dataset

PROMPT_TEMPLATE = """You are fixing a real bug in {repo} at commit {base_commit}.

<problem_statement>
{problem_statement}
</problem_statement>

Work in the current directory (already checked out at the base commit).
Edit the source files to resolve the problem. Do not commit.
When done, exit. The harness will capture `git diff` as your patch.
"""


def clone_instance(repo: str, base_commit: str, dest: Path) -> None:
    url = f"https://github.com/{repo}.git"
    subprocess.run(["git", "clone", "--quiet", url, str(dest)], check=True)
    subprocess.run(["git", "-C", str(dest), "checkout", "--quiet", base_commit], check=True)


def run_squarecode(workdir: Path, prompt: str, agent: str | None, timeout: int) -> subprocess.CompletedProcess:
    cmd = ["squarecode", "run"]
    if agent:
        cmd.append(f"--agent={agent}")
    cmd.append(prompt)
    return subprocess.run(
        cmd, cwd=workdir, stdin=subprocess.DEVNULL,
        capture_output=True, text=True, timeout=timeout,
    )


EXCLUDE_PATHS = [":(exclude).event-tracker", ":(exclude).event-tracker/**"]


def capture_patch(workdir: Path) -> str:
    subprocess.run(
        ["git", "-C", str(workdir), "add", "-A", "--", ".", *EXCLUDE_PATHS],
        check=True,
    )
    result = subprocess.run(
        ["git", "-C", str(workdir), "diff", "--cached", "--", ".", *EXCLUDE_PATHS],
        capture_output=True, text=True, check=True,
    )
    return result.stdout


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="princeton-nlp/SWE-bench_Lite")
    parser.add_argument("--split", default="test")
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--agent", default="deepwork-headless")
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--output", type=Path, default=Path("predictions.jsonl"))
    parser.add_argument("--model-name", default="squarecode")
    args = parser.parse_args()

    ds = load_dataset(args.dataset, split=args.split)
    if args.limit:
        ds = ds.select(range(min(args.limit, len(ds))))

    with args.output.open("w") as f:
        for row in ds:
            instance_id = row["instance_id"]
            print(f"[run] {instance_id}")
            workdir = Path(tempfile.mkdtemp(prefix=f"sb-{instance_id}-"))
            patch = ""
            error = None
            try:
                clone_instance(row["repo"], row["base_commit"], workdir)
                prompt = PROMPT_TEMPLATE.format(
                    repo=row["repo"],
                    base_commit=row["base_commit"],
                    problem_statement=row["problem_statement"],
                )
                proc = run_squarecode(workdir, prompt, args.agent, args.timeout)
                if proc.returncode != 0:
                    error = f"squarecode exited {proc.returncode}: {proc.stderr[-500:]}"
                patch = capture_patch(workdir)
            except subprocess.TimeoutExpired:
                error = "timeout"
            except subprocess.CalledProcessError as e:
                error = f"subprocess failed: {e}"
            finally:
                shutil.rmtree(workdir, ignore_errors=True)

            record = {
                "instance_id": instance_id,
                "model_name_or_path": args.model_name,
                "model_patch": patch,
            }
            if error:
                record["error"] = error
            f.write(json.dumps(record) + "\n")
            f.flush()

    print(f"[done] wrote {args.output}")


if __name__ == "__main__":
    main()

# SWE-bench evaluation guide

This document explains how SWE-bench evaluation works and how to run it inside
this project (`square-bench`). It's a practical, code-grounded walkthrough —
not a reproduction of the upstream README.

## What SWE-bench measures

SWE-bench asks: given a real GitHub issue from a Python project and the repo
state at the commit *before* the fix, can an agent produce a patch that makes
the project's test suite happy?

Every dataset row contains:

| field | meaning |
|---|---|
| `instance_id` | e.g. `astropy__astropy-12907` |
| `repo` | e.g. `astropy/astropy` |
| `base_commit` | commit to check out before the agent starts |
| `problem_statement` | the original issue text (the prompt) |
| `test_patch` | a hidden patch the harness applies to introduce/modify tests |
| `FAIL_TO_PASS` | tests that currently fail; your fix must make them pass |
| `PASS_TO_PASS` | tests that currently pass; your fix must not break them |
| `environment_setup_commit` | commit used to build the testbed container |

The agent only sees `repo`, `base_commit`, and `problem_statement`. Everything
else is evaluation-side data that the harness uses to grade.

## The prediction format

The harness expects a JSONL file where each row has three required keys:

```json
{"instance_id": "astropy__astropy-12907",
 "model_name_or_path": "squarecode",
 "model_patch": "diff --git a/astropy/modeling/separable.py ...\n"}
```

- `instance_id` must match a row in the target dataset exactly, or the harness
  raises `ValueError` before any Docker work starts.
- `model_name_or_path` identifies *your* system. Slashes become `__` in log paths.
- `model_patch` is a **unified diff** against `base_commit`. If it's `""` or
  `null` the instance is counted as "empty patch" and skipped.

Our runner (`run_swebench.py`) now generates this file automatically at
`workspace/predictions.jsonl`. It also writes each row's `model_patch` to
`workspace/tasks/<id>/model_patch.diff` so you can inspect patches individually.

## How the harness runs

The canonical evaluator is `swebench.harness.run_evaluation`. It is pinned
to Docker — every instance runs in its own container so side-effects can't
leak between instances. The per-instance pipeline:

1. **Build/pull container** — an image tagged per-instance
   (`swebench/sweb.eval.x86_64.<instance>:latest` by default) with the
   environment, Python, and `testbed` repo pre-installed at
   `environment_setup_commit`.
2. **Write the patch** — your `model_patch` string is written to
   `log_dir/patch.diff`, copied into the container at `/tmp/patch.diff`.
3. **Apply** — three fallbacks are tried in order:
   - `git apply --verbose`
   - `git apply --verbose --reject`
   - `patch --batch --fuzz=5 -p1 -i`
   If none succeed, the instance is marked **error** and no report is written.
4. **Run the eval script** — a per-instance `eval.sh` (derived from
   `test_spec.eval_script`) runs the project's test framework against
   `FAIL_TO_PASS` + `PASS_TO_PASS`. Capped by `--timeout` (default 1800s).
5. **Grade** — `get_eval_report` parses the raw test output with a repo-specific
   log parser (pytest, unittest, …) and writes a `report.json`.
6. **Cleanup** — the container is stopped and removed. The image may also be
   removed depending on `--cache_level`.

Key properties:

- **Resumable** — if `report.json` already exists for a given `run_id`,
  that instance is skipped. Re-running with the same `run_id` picks up where
  a previous run left off.
- **Parallel** — `--max_workers` (default 4) runs N containers concurrently.
  Should be ≤75% of CPU cores; each container can use several GB of RAM.
- **No callback hook** — the only external signal that an instance is done is
  a new `report.json` appearing on disk. Our backend polls for it.

## Where artifacts land

The harness writes everything relative to its **current working directory**
(the `--report_dir` flag only calls `mkdir` and does nothing else). Our server
spawns the harness with `cwd = workspace/evaluate/`, so:

```
workspace/evaluate/
├── logs/run_evaluation/<run_id>/<model>/<instance_id>/
│   ├── report.json        ← per-instance grading (watcher reads this)
│   ├── run_instance.log   ← harness debug log
│   ├── test_output.txt    ← raw stdout/stderr of eval.sh
│   ├── patch.diff         ← the model_patch that was attempted
│   └── eval.sh            ← the test runner script
└── <model>.<run_id>.json  ← final aggregated summary
```

Per-instance `report.json` shape:

```json
{
  "astropy__astropy-12907": {
    "patch_is_None": false,
    "patch_exists": true,
    "patch_successfully_applied": true,
    "resolved": true,
    "tests_status": {
      "FAIL_TO_PASS": {"success": ["test_a"], "failure": []},
      "PASS_TO_PASS": {"success": ["test_b", "test_c"], "failure": []}
    }
  }
}
```

## Metrics

| metric | definition | where to read it |
|---|---|---|
| **Resolved rate** | `% of instances where all FAIL_TO_PASS pass AND all PASS_TO_PASS still pass` — the headline leaderboard number | `resolved_instances / total_instances` in the summary, `resolved: true` per instance |
| **Apply rate** | `% of predictions where git apply succeeded` — catches malformed diffs | `patch_successfully_applied: true` per instance |
| **Empty-patch rate** | `% of rows with "" or null model_patch` — these are never even run | `empty_patch_instances` in the summary |
| **Error rate** | `% where the harness couldn't complete (apply failed / timeout / infra error)` | `error_instances` in the summary |
| **F2P / P2P breakdown** | per-test counts, useful for diagnosing partial fixes | `tests_status` per instance |

An instance is counted as **resolved** only if *every* `FAIL_TO_PASS` test
passes and *no* `PASS_TO_PASS` test has regressed. Fixing 19 out of 20 failing
tests still gets 0 on the resolved metric — the test is binary.

## Running evaluation in this project

### One-time setup

```bash
# create venv and install deps
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install swebench   # adds the harness

# make sure Docker is running
docker ps
```

### Workflow

```bash
# terminal 1 — backend
.venv/bin/uvicorn api.server:app --port 8000 --reload

# terminal 2 — frontend
cd web && NEXT_PUBLIC_API_BASE=http://localhost:8000 npm run dev
```

Open http://localhost:3000 and:

1. **Start** — runs `run_swebench.py` against the dataset/split/limit/agent
   you chose. Produces:
   - `workspace/clones/<id>/` — the checked-out repo (for the Files tab)
   - `workspace/tasks/<id>/files/` — modified files
   - `workspace/tasks/<id>/diffs/` — per-file diffs (for the Diffs tab)
   - `workspace/tasks/<id>/model_patch.diff` — aggregated patch
   - `workspace/predictions.jsonl` — one JSONL row per instance
2. **Evaluate** — spawns the harness against `predictions.jsonl` with
   `run_id = sq-<unix-ts>`. The **Eval** tab fills in progressively as each
   `report.json` lands:
   - status pill per task (✓ resolved / ✗ unresolved / ⚠ patch failed /
     waiting…)
   - summary metrics (resolved, resolved rate, apply rate, empty patch)
   - per-instance F2P / P2P pass counts

### Same thing from the command line

If you'd rather skip the UI:

```bash
# run the agent across 3 instances
.venv/bin/python run_swebench.py \
  --dataset princeton-nlp/SWE-bench_Lite \
  --split test \
  --limit 3 \
  --agent deepwork-headless \
  --tasks-dir workspace/tasks \
  --events workspace/events.jsonl \
  --output workspace/predictions.jsonl

# evaluate
cd workspace/evaluate
.venv/bin/python -m swebench.harness.run_evaluation \
  --predictions_path ../predictions.jsonl \
  --dataset_name SWE-bench/SWE-bench_Lite \
  --split test \
  --max_workers 4 \
  --timeout 1800 \
  --cache_level env \
  --run_id sq-$(date +%s)

# inspect results
cat squarecode.sq-*.json | jq '.'
find logs/run_evaluation -name report.json
```

### Reading the summary yourself

The aggregated `<model>.<run_id>.json` looks like:

```json
{
  "total_instances": 3,
  "submitted_instances": 3,
  "completed_instances": 2,
  "resolved_instances": 1,
  "unresolved_instances": 1,
  "empty_patch_instances": 0,
  "error_instances": 1,
  "resolved_ids": ["astropy__astropy-12907"],
  "unresolved_ids": ["astropy__astropy-14182"],
  "error_ids": ["astropy__astropy-14365"],
  "schema_version": 2
}
```

- `completed_instances` = instances where the harness ran all the way through
  grading (resolved + unresolved).
- `error_instances` + `completed_instances` + `empty_patch_instances` +
  `incomplete_ids` = `total_instances`.

## Interpreting common outcomes

- **Patch applied but resolved=false**: your fix didn't fully solve the issue.
  Open `test_output.txt` in `logs/run_evaluation/<run_id>/<model>/<id>/` and
  look at which `FAIL_TO_PASS` tests are still failing, or which
  `PASS_TO_PASS` tests regressed.
- **patch failed to apply**: the three `git apply` fallbacks all bounced the
  diff. Usually means the patch has the wrong context lines (whitespace drift)
  or targets line numbers that don't exist at `base_commit`. Inspect
  `patch.diff` alongside the source in the clone.
- **empty_patch_instances high**: the agent gave up (no edits at all) or was
  stopped before writing. The `predictions.jsonl` row will have
  `"model_patch": ""` — check `runner.log` for that instance's stderr.
- **error_instances but no patch failure**: usually a timeout — the test run
  exceeded `--timeout`. `test_output.txt` will end with a timeout marker.
- **unstopped_containers in the summary**: the harness couldn't clean up some
  containers (often because you SIGKILLed the subprocess). `docker ps -a |
  grep <run_id>` + `docker rm -f` will clean them up.

## Disk and cache considerations

First time you evaluate a given instance, Docker will pull a multi-GB prebuilt
image from `swebench/sweb.eval.x86_64.<instance>:latest`. After that:

- `--cache_level=instance` keeps everything (fastest, most disk).
- `--cache_level=env` *(default)* removes per-instance images but keeps the
  env layer, so re-running the same instance pays a small rebuild.
- `--cache_level=base` removes env images too; rebuilds on every run.
- `--cache_level=none` removes everything; expensive.

For local iteration: stick with `env`. For CI that evaluates once: `none`.

## Cloud evaluation (optional)

If you don't want Docker locally, use [sb-cli](https://github.com/swe-bench/sb-cli).
Upload your `predictions.jsonl`, they run it on their infra, and you get the
same `report.json` back. Requires an API key and internet.

```bash
pip install sb-cli
sb-cli submit --predictions workspace/predictions.jsonl \
              --dataset SWE-bench/SWE-bench_Lite
```

We don't integrate sb-cli yet — the Evaluate button only drives the local
harness.

## Related files

- `run_swebench.py` — generates `predictions.jsonl` and per-instance artifacts
- `api/server.py` — `/api/evaluate*` endpoints spawn the harness and watch
  for `report.json` files
- `web/app/page.tsx` — **Eval** tab renders the harness output live
- `workspace/` — all runtime artifacts live here (gitignored)

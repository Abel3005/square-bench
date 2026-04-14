"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeView, DiffCodeView } from "./CodeView";

const API = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

type Phase = "queued" | "cloning" | "running" | "saving" | "done" | "error";

type FileEntry = { path: string; added: number; removed: number };

type TaskState = {
  instanceId: string;
  repo: string;
  baseCommit: string;
  log: string[];
  files: FileEntry[];
  phase: Phase;
  error: string | null;
};

type TaskSeed = {
  instance_id: string;
  repo: string;
  base_commit: string;
};

type Event = {
  type: string;
  instance_id?: string;
  line?: string;
  repo?: string;
  base_commit?: string;
  path?: string;
  added?: number;
  removed?: number;
  error?: string | null;
  returncode?: number;
  tasks?: TaskSeed[];
  run_id?: string;
  resolved?: boolean;
  patch_applied?: boolean;
  patch_is_none?: boolean;
  summary?: EvalSummary;
  tests_status?: unknown;
};

type Tab = "log" | "files" | "diffs" | "eval";

type EvalResult = {
  resolved?: boolean;
  patchApplied?: boolean;
  patchIsNone?: boolean;
  error?: string;
  tests?: unknown;
};

type EvalSummary = {
  total: number;
  resolved: number;
  applied: number;
  empty_patch: number;
  resolved_rate: number;
  apply_rate: number;
};

const PHASE_COLOR: Record<Phase, string> = {
  queued: "bg-neutral-700 text-neutral-200",
  cloning: "bg-sky-700 text-sky-50",
  running: "bg-amber-600 text-amber-50",
  saving: "bg-indigo-600 text-indigo-50",
  done: "bg-emerald-600 text-emerald-50",
  error: "bg-rose-700 text-rose-50",
};

const DEFAULT_FORM = {
  dataset: "princeton-nlp/SWE-bench_Lite",
  split: "test",
  limit: 3,
  agent: "deepwork-headless",
  timeout: 1800,
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

function emptyTask(seed: TaskSeed): TaskState {
  return {
    instanceId: seed.instance_id,
    repo: seed.repo,
    baseCommit: seed.base_commit,
    log: [],
    files: [],
    phase: "queued",
    error: null,
  };
}

export default function Page() {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [tasks, setTasks] = useState<Record<string, TaskState>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("log");
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openDiff, setOpenDiff] = useState<{ path: string; text: string } | null>(null);
  const [openFile, setOpenFile] = useState<{ path: string; text: string } | null>(null);
  const [tree, setTree] = useState<{ paths: string[]; ready: boolean; truncated?: boolean } | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [evalRunning, setEvalRunning] = useState(false);
  const [evalRunId, setEvalRunId] = useState<string | null>(null);
  const [evalSummary, setEvalSummary] = useState<EvalSummary | null>(null);
  const [evalResults, setEvalResults] = useState<Record<string, EvalResult>>({});
  const logRef = useRef<HTMLPreElement>(null);

  const applyEvent = useCallback((ev: Event) => {
    if (ev.type === "tasks_created" && ev.tasks) {
      const seeds = ev.tasks;
      setTasks(() => {
        const next: Record<string, TaskState> = {};
        for (const s of seeds) next[s.instance_id] = emptyTask(s);
        return next;
      });
      setOrder(seeds.map((s) => s.instance_id));
      setCurrent(seeds[0]?.instance_id ?? null);
      return;
    }
    if (ev.type === "run_start") {
      setRunning(true);
      setError(null);
      return;
    }
    if (ev.type === "run_done") {
      setRunning(false);
      return;
    }
    if (ev.type === "evaluate_start") {
      setEvalRunning(true);
      setEvalRunId(ev.run_id ?? null);
      setEvalSummary(null);
      setEvalResults({});
      return;
    }
    if (ev.type === "evaluate_instance") {
      const id = ev.instance_id;
      if (!id) return;
      setEvalResults((prev) => ({
        ...prev,
        [id]: {
          resolved: ev.resolved,
          patchApplied: ev.patch_applied,
          patchIsNone: ev.patch_is_none,
          tests: ev.tests_status,
        },
      }));
      return;
    }
    if (ev.type === "evaluate_done") {
      setEvalRunning(false);
      if (ev.summary) setEvalSummary(ev.summary);
      return;
    }

    const id = ev.instance_id;
    if (!id) return;

    setTasks((prev) => {
      const existing: TaskState =
        prev[id] ??
        emptyTask({ instance_id: id, repo: ev.repo ?? "", base_commit: ev.base_commit ?? "" });
      const t: TaskState = { ...existing };

      switch (ev.type) {
        case "instance_start":
          if (ev.repo) t.repo = ev.repo;
          if (ev.base_commit) t.baseCommit = ev.base_commit;
          break;
        case "clone_start":
          t.phase = "cloning";
          t.log = [...t.log, "⇣ cloning repo..."];
          break;
        case "clone_done":
          t.log = [...t.log, "✓ cloned"];
          break;
        case "agent_start":
          t.phase = "running";
          t.log = [...t.log, "▶ squarecode running..."];
          break;
        case "agent_stdout":
          t.log = [...t.log, stripAnsi(ev.line ?? "")];
          break;
        case "agent_done":
          t.log = [...t.log, `✓ agent exited (rc=${ev.returncode ?? 0})`];
          t.phase = "saving";
          break;
        case "file_saved": {
          const entry: FileEntry = {
            path: ev.path ?? "",
            added: ev.added ?? 0,
            removed: ev.removed ?? 0,
          };
          t.files = [...t.files, entry];
          t.log = [...t.log, `💾 ${entry.path}  +${entry.added} -${entry.removed}`];
          break;
        }
        case "instance_done":
          t.phase = ev.error ? "error" : "done";
          t.error = ev.error ?? null;
          t.log = [...t.log, ev.error ? `✗ ${ev.error}` : "✓ done"];
          break;
      }
      return { ...prev, [id]: t };
    });
  }, []);

  // Initial state + live events.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API}/api/state`);
        if (!r.ok) throw new Error(`state http ${r.status}`);
        const j = await r.json();
        if (cancelled) return;
        setRunning(Boolean(j.running));
        for (const ev of j.events as Event[]) applyEvent(ev);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`backend unreachable: ${msg}`);
      }
      try {
        const r = await fetch(`${API}/api/evaluate/status`);
        if (r.ok) {
          const j = await r.json();
          if (cancelled) return;
          setEvalRunning(Boolean(j.running));
          setEvalRunId(j.run_id ?? null);
          if (j.report?.summary) setEvalSummary(j.report.summary);
          if (j.report?.instances) {
            const map: Record<string, EvalResult> = {};
            for (const [iid, r] of Object.entries(j.report.instances as Record<string, Record<string, unknown>>)) {
              map[iid] = {
                resolved: Boolean(r.resolved),
                patchApplied: Boolean(r.patch_successfully_applied),
                patchIsNone: Boolean(r.patch_is_None),
                tests: r.tests_status,
              };
            }
            setEvalResults(map);
          }
        }
      } catch {
        /* evaluate status optional */
      }
    })();

    const es = new EventSource(`${API}/api/events`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        applyEvent(JSON.parse(e.data) as Event);
      } catch {
        /* ignore */
      }
    };
    return () => {
      cancelled = true;
      es.close();
    };
  }, [applyEvent]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [current, tasks, tab]);

  const currentTask = useMemo(
    () => (current ? tasks[current] : null),
    [current, tasks],
  );

  const start = async () => {
    setError(null);
    const r = await fetch(`${API}/api/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      setError(`start failed: ${body.detail ?? r.status}`);
      return;
    }
    setTasks({});
    setOrder([]);
    setCurrent(null);
    setTab("log");
  };

  const stop = async () => {
    try {
      const r = await fetch(`${API}/api/stop`, { method: "POST" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setError(`stop failed: ${body.detail ?? r.status}`);
        return;
      }
    } catch (e: unknown) {
      setError(`stop failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // If run_done never arrives (e.g. runner was SIGKILLed before emitting),
    // reconcile with the backend so the Start button isn't stuck disabled.
    setTimeout(async () => {
      try {
        const r = await fetch(`${API}/api/status`);
        if (r.ok) {
          const j = await r.json();
          setRunning(Boolean(j.running));
        }
      } catch {
        setRunning(false);
      }
    }, 2000);
  };

  const startEvaluation = async () => {
    setError(null);
    const r = await fetch(`${API}/api/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      setError(`evaluate failed: ${body.detail ?? r.status}`);
      return;
    }
    setTab("eval");
  };

  const stopEvaluation = async () => {
    try {
      const r = await fetch(`${API}/api/evaluate/stop`, { method: "POST" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setError(`stop eval failed: ${body.detail ?? r.status}`);
        return;
      }
    } catch (e: unknown) {
      setError(`stop eval failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setTimeout(async () => {
      try {
        const r = await fetch(`${API}/api/evaluate/status`);
        if (r.ok) {
          const j = await r.json();
          setEvalRunning(Boolean(j.running));
        }
      } catch {
        setEvalRunning(false);
      }
    }, 2000);
  };

  const openDiffFile = async (instanceId: string, path: string) => {
    const r = await fetch(
      `${API}/api/tasks/${encodeURIComponent(instanceId)}/diff?path=${encodeURIComponent(path)}`,
    );
    const text = r.ok ? await r.text() : `<error: ${r.status}>`;
    setOpenDiff({ path, text });
    setOpenFile(null);
  };

  const openSourceFile = async (instanceId: string, path: string) => {
    const r = await fetch(
      `${API}/api/tasks/${encodeURIComponent(instanceId)}/source?path=${encodeURIComponent(path)}`,
    );
    const text = r.ok ? await r.text() : `<error: ${r.status}>`;
    setOpenFile({ path, text });
    setOpenDiff(null);
  };

  const refreshTree = useCallback(async (instanceId: string) => {
    setTreeLoading(true);
    try {
      const r = await fetch(`${API}/api/tasks/${encodeURIComponent(instanceId)}/tree`);
      if (!r.ok) {
        setTree({ paths: [], ready: false });
        return;
      }
      const j = (await r.json()) as { ready: boolean; paths: string[]; truncated?: boolean };
      setTree(j);
    } finally {
      setTreeLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab !== "files" || !current) return;
    setOpenFile(null);
    refreshTree(current);
  }, [tab, current, refreshTree]);

  return (
    <main className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-4 py-3">
        <h1 className="mr-4 text-sm font-semibold tracking-wide text-neutral-200">
          square-bench · live
        </h1>
        <Field label="dataset" value={form.dataset} width="w-60"
          onChange={(v) => setForm({ ...form, dataset: v })} />
        <Field label="split" value={form.split} width="w-20"
          onChange={(v) => setForm({ ...form, split: v })} />
        <Field label="limit" value={String(form.limit)} width="w-14"
          onChange={(v) => setForm({ ...form, limit: Number(v) || 0 })} />
        <Field label="agent" value={form.agent} width="w-44"
          onChange={(v) => setForm({ ...form, agent: v })} />
        <Field label="timeout" value={String(form.timeout)} width="w-20"
          onChange={(v) => setForm({ ...form, timeout: Number(v) || 0 })} />
        <button
          onClick={start}
          disabled={running}
          className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          Start
        </button>
        <button
          onClick={stop}
          disabled={!running}
          className="rounded bg-rose-700 px-3 py-1 text-xs font-semibold text-white hover:bg-rose-600 disabled:opacity-40"
        >
          Stop
        </button>
        <div className="mx-2 h-5 w-px bg-neutral-700" />
        <button
          onClick={startEvaluation}
          disabled={running || evalRunning}
          title="Run the SWE-bench harness on predictions.jsonl"
          className="rounded bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          Evaluate
        </button>
        <button
          onClick={stopEvaluation}
          disabled={!evalRunning}
          className="rounded bg-rose-800 px-3 py-1 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-40"
        >
          Stop Eval
        </button>
        <div className="ml-auto flex items-center gap-3 text-[11px]">
          <span className={`rounded px-2 py-0.5 ${connected ? "bg-emerald-700" : "bg-rose-800"}`}>
            {connected ? "● live" : "○ offline"}
          </span>
          <span className="text-neutral-400">
            {running ? "running" : "idle"}
          </span>
          {evalRunning && (
            <span className="rounded bg-indigo-700 px-2 py-0.5 text-indigo-50">
              evaluating…
            </span>
          )}
          {evalSummary && !evalRunning && (
            <span className="rounded bg-indigo-900 px-2 py-0.5 text-indigo-200">
              resolved {evalSummary.resolved}/{evalSummary.total}
            </span>
          )}
        </div>
      </header>

      {error && (
        <div className="border-b border-rose-900 bg-rose-950 px-4 py-2 text-xs text-rose-200">
          {error}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-neutral-800">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-neutral-500">
            Queue ({order.length})
          </div>
          {order.length === 0 && (
            <div className="px-3 py-4 text-[11px] text-neutral-500">
              Press <b className="text-neutral-300">Start</b> to load tasks from the dataset.
            </div>
          )}
          {order.map((id) => {
            const t = tasks[id];
            if (!t) return null;
            const active = id === current;
            return (
              <button
                key={id}
                onClick={() => {
                  setCurrent(id);
                  setOpenDiff(null);
                  setOpenFile(null);
                }}
                className={`block w-full border-l-2 px-3 py-2 text-left text-[11px] transition ${
                  active
                    ? "border-emerald-500 bg-neutral-900"
                    : "border-transparent hover:bg-neutral-900"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-neutral-200">{id}</span>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold ${PHASE_COLOR[t.phase]}`}>
                    {t.phase}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[10px] text-neutral-500">
                  {t.repo}
                </div>
                {t.files.length > 0 && (
                  <div className="mt-0.5 text-[10px] text-neutral-400">
                    {t.files.length} file{t.files.length > 1 ? "s" : ""} modified
                  </div>
                )}
                {evalResults[id] && (
                  <div className="mt-0.5 text-[10px]">
                    {evalResults[id].resolved ? (
                      <span className="text-emerald-400">✓ resolved</span>
                    ) : evalResults[id].patchApplied ? (
                      <span className="text-rose-400">✗ unresolved</span>
                    ) : (
                      <span className="text-amber-400">⚠ patch failed</span>
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </aside>

        <section className="flex flex-1 flex-col overflow-hidden">
          <div className="flex items-center gap-1 border-b border-neutral-800 px-3 py-2">
            <div className="mr-3 flex-1 text-[11px] text-neutral-400">
              {currentTask ? (
                <span>
                  <span className="font-mono text-neutral-200">{currentTask.instanceId}</span>
                  <span className="ml-2 text-neutral-500">
                    {currentTask.repo} @ {currentTask.baseCommit.slice(0, 8)}
                  </span>
                </span>
              ) : (
                "Select a task from the queue"
              )}
            </div>
            <TabBtn active={tab === "log"} onClick={() => setTab("log")}>Log</TabBtn>
            <TabBtn active={tab === "files"} onClick={() => setTab("files")}>
              Files
            </TabBtn>
            <TabBtn active={tab === "diffs"} onClick={() => setTab("diffs")}>
              Diffs ({currentTask?.files.length ?? 0})
            </TabBtn>
            <TabBtn active={tab === "eval"} onClick={() => setTab("eval")}>
              Eval
            </TabBtn>
          </div>

          <div className="flex flex-1 overflow-hidden">
            {tab === "log" && (
              <pre
                ref={logRef}
                className="flex-1 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[11px] leading-relaxed text-neutral-200"
              >
                {currentTask ? currentTask.log.join("\n") : ""}
              </pre>
            )}

            {tab === "files" && currentTask && (
              <div className="flex flex-1 overflow-hidden">
                <div className="flex w-80 shrink-0 flex-col border-r border-neutral-800">
                  <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-1 text-[10px] uppercase tracking-wider text-neutral-500">
                    <span>Explorer</span>
                    <button
                      onClick={() => current && refreshTree(current)}
                      className="rounded bg-neutral-800 px-2 py-0.5 text-[10px] normal-case text-neutral-300 hover:bg-neutral-700"
                    >
                      refresh
                    </button>
                  </div>
                  <div className="flex-1 overflow-auto py-1">
                    {treeLoading && (
                      <div className="px-3 py-2 text-[11px] text-neutral-500">loading…</div>
                    )}
                    {!treeLoading && tree && !tree.ready && (
                      <div className="px-3 py-2 text-[11px] text-neutral-500">
                        Clone not ready yet. Waiting for <code>clone_done</code>.
                      </div>
                    )}
                    {!treeLoading && tree && tree.ready && tree.paths.length === 0 && (
                      <div className="px-3 py-2 text-[11px] text-neutral-500">
                        Clone is empty.
                      </div>
                    )}
                    {tree && tree.ready && tree.paths.length > 0 && (
                      <TreeView
                        paths={tree.paths}
                        modified={new Set(currentTask.files.map((f) => f.path))}
                        selected={openFile?.path ?? null}
                        onOpen={(p) => openSourceFile(currentTask.instanceId, p)}
                      />
                    )}
                    {tree?.truncated && (
                      <div className="px-3 py-2 text-[10px] text-amber-500">
                        tree truncated at {tree.paths.length.toLocaleString()} entries
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex-1 overflow-hidden">
                  {openFile ? (
                    <CodeView code={openFile.text} path={openFile.path} />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[11px] text-neutral-500">
                      Click a file to view its contents.
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === "eval" && (
              <div className="flex flex-1 flex-col overflow-auto p-4">
                {!evalSummary && !evalRunning && Object.keys(evalResults).length === 0 && (
                  <div className="text-[11px] text-neutral-500">
                    No evaluation yet. Press <b className="text-neutral-300">Evaluate</b> to run
                    the SWE-bench harness on <code>predictions.jsonl</code>. Requires Docker.
                  </div>
                )}
                {(evalSummary || Object.keys(evalResults).length > 0) && (
                  <>
                    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
                      <Metric label="total" value={evalSummary?.total ?? order.length} />
                      <Metric
                        label="resolved"
                        value={`${evalSummary?.resolved ?? Object.values(evalResults).filter((r) => r.resolved).length}`}
                        tint="emerald"
                      />
                      <Metric
                        label="resolved rate"
                        value={`${(((evalSummary?.resolved_rate ?? 0) * 100)).toFixed(1)}%`}
                        tint="emerald"
                      />
                      <Metric
                        label="apply rate"
                        value={`${(((evalSummary?.apply_rate ?? 0) * 100)).toFixed(1)}%`}
                        tint="sky"
                      />
                      <Metric
                        label="empty patch"
                        value={`${evalSummary?.empty_patch ?? 0}`}
                        tint="amber"
                      />
                    </div>
                    <div className="overflow-hidden rounded border border-neutral-800">
                      <table className="w-full text-[11px]">
                        <thead className="bg-neutral-900 text-neutral-400">
                          <tr>
                            <th className="px-3 py-1.5 text-left">instance</th>
                            <th className="px-3 py-1.5 text-left">status</th>
                            <th className="px-3 py-1.5 text-left">patch applied</th>
                            <th className="px-3 py-1.5 text-left">FAIL→PASS</th>
                            <th className="px-3 py-1.5 text-left">PASS→PASS</th>
                          </tr>
                        </thead>
                        <tbody>
                          {order.map((id) => {
                            const r = evalResults[id];
                            const tests = r?.tests as
                              | {
                                  FAIL_TO_PASS?: { success?: string[]; failure?: string[] };
                                  PASS_TO_PASS?: { success?: string[]; failure?: string[] };
                                }
                              | undefined;
                            const f2p = tests?.FAIL_TO_PASS;
                            const p2p = tests?.PASS_TO_PASS;
                            return (
                              <tr key={id} className="border-t border-neutral-800">
                                <td className="px-3 py-1.5 font-mono text-neutral-200">{id}</td>
                                <td className="px-3 py-1.5">
                                  {!r ? (
                                    <span className="text-neutral-500">
                                      {evalRunning ? "waiting…" : "not evaluated"}
                                    </span>
                                  ) : r.resolved ? (
                                    <span className="text-emerald-400">✓ resolved</span>
                                  ) : r.patchApplied ? (
                                    <span className="text-rose-400">✗ unresolved</span>
                                  ) : (
                                    <span className="text-amber-400">⚠ patch failed</span>
                                  )}
                                </td>
                                <td className="px-3 py-1.5">
                                  {r ? (r.patchApplied ? "✓" : "✗") : "—"}
                                </td>
                                <td className="px-3 py-1.5 font-mono text-[10px] text-neutral-400">
                                  {f2p
                                    ? `${(f2p.success ?? []).length}/${(f2p.success ?? []).length + (f2p.failure ?? []).length}`
                                    : "—"}
                                </td>
                                <td className="px-3 py-1.5 font-mono text-[10px] text-neutral-400">
                                  {p2p
                                    ? `${(p2p.success ?? []).length}/${(p2p.success ?? []).length + (p2p.failure ?? []).length}`
                                    : "—"}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {evalRunId && (
                      <div className="mt-3 text-[10px] text-neutral-500">
                        run_id: <code>{evalRunId}</code>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {tab === "diffs" && currentTask && (
              <div className="flex flex-1 overflow-hidden">
                <ul className="w-72 shrink-0 overflow-y-auto border-r border-neutral-800 py-2">
                  {currentTask.files.length === 0 && (
                    <li className="px-3 py-2 text-[11px] text-neutral-500">
                      No diffs yet.
                    </li>
                  )}
                  {currentTask.files.map((f) => (
                    <li key={f.path}>
                      <button
                        onClick={() => openDiffFile(currentTask.instanceId, f.path)}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-1 text-left font-mono text-[11px] hover:bg-neutral-900 ${
                          openDiff?.path === f.path ? "bg-neutral-900 text-emerald-300" : "text-neutral-300"
                        }`}
                      >
                        <span className="truncate">{f.path}</span>
                        <span className="shrink-0 text-[10px]">
                          <span className="text-emerald-400">+{f.added}</span>
                          <span className="ml-1 text-rose-400">-{f.removed}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="flex-1 overflow-hidden">
                  {openDiff ? (
                    <DiffCodeView text={openDiff.text} />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[11px] text-neutral-500">
                      Click a file to view its diff.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  width,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  width: string;
}) {
  return (
    <label className="flex items-center gap-1 text-[11px] text-neutral-400">
      <span>{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${width} rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-[11px] text-neutral-100 focus:border-emerald-600 focus:outline-none`}
      />
    </label>
  );
}

function Metric({
  label,
  value,
  tint,
}: {
  label: string;
  value: string | number;
  tint?: "emerald" | "sky" | "amber" | "rose";
}) {
  const tintCls =
    tint === "emerald"
      ? "text-emerald-300"
      : tint === "sky"
        ? "text-sky-300"
        : tint === "amber"
          ? "text-amber-300"
          : tint === "rose"
            ? "text-rose-300"
            : "text-neutral-100";
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold ${tintCls}`}>{value}</div>
    </div>
  );
}

type TreeNode = {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
};

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  for (const p of paths) {
    if (!p) continue;
    const parts = p.split("/");
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLast = i === parts.length - 1;
      let child = cur.children.find((c) => c.name === name);
      if (!child) {
        child = {
          name,
          path: parts.slice(0, i + 1).join("/"),
          isDir: !isLast,
          children: [],
        };
        cur.children.push(child);
      }
      cur = child;
    }
  }
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

function TreeView({
  paths,
  modified,
  selected,
  onOpen,
}: {
  paths: string[];
  modified: Set<string>;
  selected: string | null;
  onOpen: (path: string) => void;
}) {
  const root = useMemo(() => buildTree(paths), [paths]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));

  const toggle = (p: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  const render = (node: TreeNode, depth: number): React.ReactNode[] => {
    const rows: React.ReactNode[] = [];
    for (const child of node.children) {
      const pad = { paddingLeft: `${depth * 12 + 8}px` };
      if (child.isDir) {
        const open = expanded.has(child.path);
        rows.push(
          <div
            key={child.path}
            onClick={() => toggle(child.path)}
            style={pad}
            className="flex cursor-pointer items-center gap-1 py-0.5 font-mono text-[11px] text-neutral-300 hover:bg-neutral-900"
          >
            <span className="w-3 text-neutral-500">{open ? "▾" : "▸"}</span>
            <span className="text-sky-400">📁</span>
            <span className="truncate">{child.name}</span>
          </div>,
        );
        if (open) rows.push(...render(child, depth + 1));
      } else {
        const isMod = modified.has(child.path);
        const isSel = selected === child.path;
        rows.push(
          <div
            key={child.path}
            onClick={() => onOpen(child.path)}
            style={pad}
            className={`flex cursor-pointer items-center gap-1 py-0.5 font-mono text-[11px] hover:bg-neutral-900 ${
              isSel ? "bg-neutral-800 text-emerald-300" : "text-neutral-300"
            }`}
          >
            <span className="w-3" />
            <span className="text-neutral-500">·</span>
            <span className="truncate">{child.name}</span>
            {isMod && (
              <span className="ml-auto pr-2 text-[10px] text-amber-400">M</span>
            )}
          </div>,
        );
      }
    }
    return rows;
  };

  return <div>{render(root, 0)}</div>;
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-3 py-1 text-[11px] font-medium transition ${
        active
          ? "bg-emerald-600 text-white"
          : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
      }`}
    >
      {children}
    </button>
  );
}


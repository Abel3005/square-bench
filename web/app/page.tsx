"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Phase = "pending" | "cloning" | "running" | "saving" | "done" | "error";

type TaskState = {
  instanceId: string;
  repo?: string;
  baseCommit?: string;
  log: string[];
  files: string[];
  phase: Phase;
  error?: string | null;
};

type Event = {
  type: string;
  instance_id?: string;
  line?: string;
  repo?: string;
  base_commit?: string;
  path?: string;
  error?: string | null;
  returncode?: number;
  ts?: number;
};

const PHASE_CLASS: Record<Phase, string> = {
  pending: "bg-neutral-800 text-neutral-300",
  cloning: "bg-sky-800/60 text-sky-200",
  running: "bg-amber-800/60 text-amber-100",
  saving: "bg-indigo-800/60 text-indigo-100",
  done: "bg-emerald-800/60 text-emerald-100",
  error: "bg-rose-900/70 text-rose-100",
};

const DEFAULT_FORM = {
  dataset: "princeton-nlp/SWE-bench_Lite",
  split: "test",
  limit: 3,
  agent: "deepwork-headless",
  timeout: 1800,
};

export default function Page() {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [tasks, setTasks] = useState<Record<string, TaskState>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string>("idle");
  const [openFile, setOpenFile] = useState<{ path: string; body: string } | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const ensureTask = useCallback((id: string) => {
    setTasks((prev) => {
      if (prev[id]) return prev;
      return {
        ...prev,
        [id]: {
          instanceId: id,
          log: [],
          files: [],
          phase: "pending",
        },
      };
    });
    setOrder((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const applyEvent = useCallback((ev: Event) => {
    const id = ev.instance_id;
    if (!id) return;
    setTasks((prev) => {
      const existing: TaskState = prev[id] ?? {
        instanceId: id,
        log: [],
        files: [],
        phase: "pending",
      };
      const next: TaskState = { ...existing };
      switch (ev.type) {
        case "instance_start":
          next.repo = ev.repo;
          next.baseCommit = ev.base_commit;
          next.log = [...next.log, `▶ ${ev.repo ?? ""} @ ${ev.base_commit ?? ""}`];
          next.phase = "pending";
          break;
        case "clone_start":
          next.phase = "cloning";
          next.log = [...next.log, "⇣ cloning..."];
          break;
        case "clone_done":
          next.log = [...next.log, "✓ cloned"];
          break;
        case "agent_start":
          next.phase = "running";
          next.log = [...next.log, "▶ squarecode running..."];
          break;
        case "agent_stdout":
          next.log = [...next.log, ev.line ?? ""];
          break;
        case "agent_done":
          next.log = [...next.log, `✓ agent exited (${ev.returncode ?? 0})`];
          next.phase = "saving";
          break;
        case "file_saved":
          next.files = [...next.files, ev.path ?? ""];
          next.log = [...next.log, `💾 ${ev.path ?? ""}`];
          break;
        case "instance_done":
          next.phase = ev.error ? "error" : "done";
          next.error = ev.error ?? null;
          next.log = [
            ...next.log,
            ev.error ? `✗ ${ev.error}` : "✓ done",
          ];
          break;
      }
      return { ...prev, [id]: next };
    });
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      let ev: Event;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      if (ev.type === "run_start") setRunStatus("running");
      if (ev.type === "run_done") setRunStatus("done");
      if (ev.instance_id) {
        ensureTask(ev.instance_id);
        applyEvent(ev);
      }
    };
    return () => es.close();
  }, [ensureTask, applyEvent]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [current, tasks]);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((j) => setRunStatus(j.running ? "running" : "idle"))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!current && order.length > 0) setCurrent(order[0]);
  }, [order, current]);

  const currentTask = useMemo(
    () => (current ? tasks[current] : null),
    [current, tasks],
  );

  const start = async () => {
    const r = await fetch("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setRunStatus(`error: ${j.detail ?? r.status}`);
      return;
    }
    setTasks({});
    setOrder([]);
    setCurrent(null);
    setRunStatus("running");
  };

  const stop = async () => {
    await fetch("/api/stop", { method: "POST" });
    setRunStatus("stopped");
  };

  const openFilePreview = async (instanceId: string, path: string) => {
    const r = await fetch(
      `/api/tasks/${encodeURIComponent(instanceId)}/file?path=${encodeURIComponent(path)}`,
    );
    const body = await r.text();
    setOpenFile({ path, body });
  };

  return (
    <main className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-4 text-sm font-semibold tracking-wide text-neutral-300">
            square-bench · live
          </h1>
          <Field label="dataset" value={form.dataset} width="w-64"
            onChange={(v) => setForm({ ...form, dataset: v })} />
          <Field label="split" value={form.split} width="w-20"
            onChange={(v) => setForm({ ...form, split: v })} />
          <Field label="limit" value={String(form.limit)} width="w-16"
            onChange={(v) => setForm({ ...form, limit: Number(v) || 0 })} />
          <Field label="agent" value={form.agent} width="w-48"
            onChange={(v) => setForm({ ...form, agent: v })} />
          <Field label="timeout" value={String(form.timeout)} width="w-24"
            onChange={(v) => setForm({ ...form, timeout: Number(v) || 0 })} />
          <button
            onClick={start}
            className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold hover:bg-emerald-500"
          >
            Start
          </button>
          <button
            onClick={stop}
            className="rounded bg-rose-700 px-3 py-1 text-xs font-semibold hover:bg-rose-600"
          >
            Stop
          </button>
          <span className="ml-2 text-xs text-neutral-400">status: {runStatus}</span>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-72 overflow-y-auto border-r border-neutral-800">
          <div className="px-3 py-2 text-xs uppercase tracking-wider text-neutral-500">
            Tasks ({order.length})
          </div>
          {order.map((id) => {
            const t = tasks[id];
            if (!t) return null;
            const active = id === current;
            return (
              <button
                key={id}
                onClick={() => setCurrent(id)}
                className={`block w-full border-l-2 px-3 py-2 text-left text-xs transition ${
                  active
                    ? "border-emerald-500 bg-neutral-900"
                    : "border-transparent hover:bg-neutral-900"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="truncate font-mono">{id}</span>
                  <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${PHASE_CLASS[t.phase]}`}>
                    {t.phase}
                  </span>
                </div>
                {t.repo && (
                  <div className="mt-0.5 truncate text-[10px] text-neutral-500">
                    {t.repo}
                  </div>
                )}
              </button>
            );
          })}
          {order.length === 0 && (
            <div className="px-3 py-4 text-xs text-neutral-600">
              No tasks yet. Press Start.
            </div>
          )}
        </aside>

        <section className="flex flex-1 flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
            <div className="text-xs text-neutral-400">
              {currentTask
                ? `${currentTask.instanceId} · ${currentTask.repo ?? ""}`
                : "Select a task"}
            </div>
            {currentTask?.error && (
              <div className="text-xs text-rose-400">{currentTask.error}</div>
            )}
          </div>
          <pre
            ref={logRef}
            className="flex-1 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-200"
          >
            {currentTask ? currentTask.log.join("\n") : ""}
          </pre>
        </section>

        <aside className="w-72 overflow-y-auto border-l border-neutral-800">
          <div className="px-3 py-2 text-xs uppercase tracking-wider text-neutral-500">
            Files{currentTask ? ` (${currentTask.files.length})` : ""}
          </div>
          {currentTask?.files.map((f) => (
            <button
              key={f}
              onClick={() => openFilePreview(currentTask.instanceId, f)}
              className="block w-full truncate px-3 py-1 text-left font-mono text-[11px] text-neutral-300 hover:bg-neutral-900"
              title={f}
            >
              {f}
            </button>
          ))}
          {currentTask && currentTask.files.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-neutral-600">
              No files saved yet.
            </div>
          )}
        </aside>
      </div>

      {openFile && (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center bg-black/70 p-8"
          onClick={() => setOpenFile(null)}
        >
          <div
            className="flex h-full max-h-[90vh] w-full max-w-5xl flex-col rounded-lg border border-neutral-700 bg-neutral-950"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
              <div className="font-mono text-xs text-neutral-300">{openFile.path}</div>
              <button
                onClick={() => setOpenFile(null)}
                className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
              >
                Close
              </button>
            </div>
            <pre className="flex-1 overflow-auto whitespace-pre px-4 py-3 font-mono text-[11px] text-neutral-200">
              {openFile.body}
            </pre>
          </div>
        </div>
      )}
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

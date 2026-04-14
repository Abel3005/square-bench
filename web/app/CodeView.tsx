"use client";

import { useEffect, useState } from "react";
import { codeToHtml, type BundledLanguage } from "shiki";

const EXT_LANG: Record<string, BundledLanguage> = {
  py: "python",
  pyi: "python",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  mdx: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  css: "css",
  scss: "scss",
  html: "html",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  rb: "ruby",
  php: "php",
  sql: "sql",
  swift: "swift",
  dockerfile: "docker",
};

function inferLang(path: string): BundledLanguage {
  const base = path.split("/").pop() ?? "";
  if (base.toLowerCase() === "dockerfile") return "docker";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return EXT_LANG[ext] ?? ("text" as BundledLanguage);
}

export function CodeView({ code, path }: { code: string; path: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    (async () => {
      try {
        const h = await codeToHtml(code, {
          lang: inferLang(path),
          theme: "dark-plus",
        });
        if (!cancelled) setHtml(h);
      } catch {
        if (!cancelled) setHtml("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, path]);

  if (html === null) {
    return (
      <div className="codeview flex items-center justify-center text-[11px] text-[#858585]">
        Highlighting…
      </div>
    );
  }
  if (!html) {
    return (
      <div className="codeview">
        <pre>
          <code>
            {code.split("\n").map((line, i) => (
              <span key={i} className="line">
                {line || " "}
              </span>
            ))}
          </code>
        </pre>
      </div>
    );
  }
  return (
    <div
      className="codeview"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

type DiffRow =
  | { kind: "header"; text: string }
  | { kind: "hunk"; text: string }
  | { kind: "context"; text: string; oldNo: number; newNo: number }
  | { kind: "add"; text: string; newNo: number }
  | { kind: "del"; text: string; oldNo: number };

function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("similarity ") ||
      raw.startsWith("rename ") ||
      raw.startsWith("\\ No newline")
    ) {
      rows.push({ kind: "header", text: raw });
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[2], 10);
      }
      rows.push({ kind: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      rows.push({ kind: "add", text: raw.slice(1), newNo: newNo++ });
      continue;
    }
    if (raw.startsWith("-")) {
      rows.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ });
      continue;
    }
    if (raw === "" && i === lines.length - 1) continue;
    rows.push({
      kind: "context",
      text: raw.startsWith(" ") ? raw.slice(1) : raw,
      oldNo: oldNo++,
      newNo: newNo++,
    });
  }
  return rows;
}

export function DiffCodeView({ text }: { text: string }) {
  if (!text.trim()) {
    return (
      <div className="diffview flex items-center px-4 text-[#858585]">
        (no diff — file unchanged)
      </div>
    );
  }
  const rows = parseDiff(text);
  return (
    <div className="diffview">
      {rows.map((r, i) => {
        if (r.kind === "header") {
          return (
            <div key={i} className="row header">
              <span className="gutter" />
              <span className="gutter" />
              <span className="sign" />
              <span className="code">{r.text}</span>
            </div>
          );
        }
        if (r.kind === "hunk") {
          return (
            <div key={i} className="row hunk">
              <span className="gutter" />
              <span className="gutter" />
              <span className="sign" />
              <span className="code">{r.text}</span>
            </div>
          );
        }
        const cls =
          r.kind === "add" ? "row add" : r.kind === "del" ? "row del" : "row";
        const oldN = r.kind === "add" ? "" : String(r.oldNo);
        const newN = r.kind === "del" ? "" : String(r.newNo);
        const sign = r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";
        return (
          <div key={i} className={cls}>
            <span className="gutter">{oldN}</span>
            <span className="gutter">{newN}</span>
            <span className="sign">{sign}</span>
            <span className="code">{r.text || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

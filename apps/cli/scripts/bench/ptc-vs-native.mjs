#!/usr/bin/env bun
// PTC vs native comparison benchmark for CodeSurf.
//
// Runs one multi-step task headless under each tool presentation
// (native / code / both) and reports the metrics the PTC spec's success
// criteria are built around: LLM round-trips (steps), tool calls, token usage
// and wall time. Same task, same model, same build — only the presentation
// differs, so the delta is the presentation's effect.
//
//   bun scripts/bench/ptc-vs-native.mjs            # table
//   bun scripts/bench/ptc-vs-native.mjs --json     # machine-readable JSON
//   bun scripts/bench/ptc-vs-native.mjs --runs 5   # samples per presentation
//   bun scripts/bench/ptc-vs-native.mjs --task "…" # override the task
//
// Requirements: a built CLI (`bun run build`) and live model credentials
// (CODESURF_API_KEY or GROK_API_KEY). Presentation is switched by
// CODESURF_TOOL_PRESENTATION, which resolvePresentation() honours; the code
// runtime is an in-process host service, so code/both need no separate node.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const runsAt = args.indexOf("--runs");
const RUNS = runsAt >= 0 ? Number(args[runsAt + 1]) : 3;
const taskAt = args.indexOf("--task");
// Forced-sequential workload: the model must read a value, then act on it, so
// native re-enters context once per dependency (round-trips are visible) —
// exactly the workload PTC is meant to collapse.
const DEFAULT_TASK =
  "Read the first 30 lines of package.json and count how many lines are package names. Then create a directory in /tmp named cnt-N where N is that exact count, and write result.txt inside it confirming the count.";
const TASK = taskAt >= 0 ? args[taskAt + 1] : DEFAULT_TASK;

const PRESENTATIONS = ["native", "code", "both"];

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function summarize(samples) {
  return {
    median: Number(median(samples).toFixed(1)),
    min: Number(Math.min(...samples).toFixed(1)),
    max: Number(Math.max(...samples).toFixed(1)),
    samples: samples.length,
  };
}

function requireBuild() {
  const res = spawnSync("bun", ["src/index.ts", "--help"], { cwd: REPO, encoding: "utf8", timeout: 30000 });
  if (res.status !== 0) {
    throw new Error("No built CLI — run `bun run build` first.");
  }
}

/** Run the task once under a presentation; returns metrics from the JSONL. */
function measure(presentation) {
  const configDir = mkdtempSync(path.join(tmpdir(), "codesurf-ptc-"));
  let wallMs = 0;
  let rounds = 0;
  let tools = 0;
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  // Runs against src/index.ts (the dev entry) so the round-trip counter is
  // always live; a dist bundle would need rebuilding every time the turn
  // loop changes. The only cost is a little cold-import per sample (wall
  // only).
  try {
    const started = performance.now();
    const res = spawnSync("bun", ["dist/index.js", "--prompt", TASK, "--format", "json"], {
      cwd: REPO,
      env: {
        ...process.env,
        CODESURF_CONFIG_DIR: configDir,
        CODESURF_TOOL_PRESENTATION: presentation,
        NO_COLOR: "1",
      },
      encoding: "utf8",
      timeout: 600_000,
    });
    wallMs = performance.now() - started;
    if (res.status !== 0) {
      const detail = (res.stderr || res.stdout || "no output").trim().split("\n").slice(-8).join("\n");
      throw new Error(`presentation ${presentation} run failed (exit ${res.status}):\n${detail}`);
    }
    for (const line of res.stdout.split("\n")) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue; // non-JSON noise
      }
      if (!ev || typeof ev !== "object") continue;
      if (ev.type === "step_finish") {
        const sn = Number(ev.stepNumber ?? 0);
        if (sn > rounds) rounds = sn;
        if (typeof ev.rounds === "number" && ev.rounds > rounds) rounds = ev.rounds;
        const u = ev.usage ?? {};
        totalTokens += Number(u.totalTokens ?? 0);
        inputTokens += Number(u.inputTokens ?? 0);
        outputTokens += Number(u.outputTokens ?? 0);
      } else if (ev.type === "tool_use") {
        tools += 1;
      }
    }
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
  return { rounds, tools, totalTokens, inputTokens, outputTokens, wallMs };
}

requireBuild();

const results = PRESENTATIONS.map((p) => {
  const sample = [];
  for (let i = 0; i < RUNS; i++) {
    sample.push(measure(p));
  }
  return {
    presentation: p,
    rounds: summarize(sample.map((s) => s.rounds)),
    tools: summarize(sample.map((s) => s.tools)),
    totalTokens: summarize(sample.map((s) => s.totalTokens)),
    wallMs: summarize(sample.map((s) => s.wallMs)),
  };
});

if (asJson) {
  console.log(JSON.stringify({ task: TASK, runs: RUNS, results }, null, 2));
} else {
  console.log(["presentation", "round-trips", "tool calls", "total tokens", "wall ms"].join("\t"));
  for (const r of results) {
    console.log(
      [
        r.presentation,
        `${r.rounds.median} (=${r.rounds.min}..${r.rounds.max})`,
        `${r.tools.median} (=${r.tools.min}..${r.tools.max})`,
        `${r.totalTokens.median} (=${r.totalTokens.min}..${r.totalTokens.max})`,
        `${r.wallMs.median} (=${r.wallMs.min}..${r.wallMs.max})ms`,
      ].join("\t"),
    );
  }
  const native = results.find((r) => r.presentation === "native");
  const code = results.find((r) => r.presentation === "code");
  if (native && code) {
    const rr = (((native.rounds.median - code.rounds.median) / native.rounds.median) * 100).toFixed(0);
    const tt = (((native.totalTokens.median - code.totalTokens.median) / native.totalTokens.median) * 100).toFixed(0);
    console.log(`\ncode vs native: ${rr}% fewer round-trips, ${tt}% fewer total tokens (median).`);
  }
}

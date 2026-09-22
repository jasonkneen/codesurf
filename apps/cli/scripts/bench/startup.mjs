#!/usr/bin/env bun
// Startup and boot cost benchmark for CodeSurf.
//
// Measures the costs the migration plan asks for at the startup boundary, with
// no network and no credentials: cold module-graph import, extension bootstrap,
// the registry snapshot rebuild, and the built CLI's time to render --help.
//
// Every run is isolated: CODESURF_CONFIG_DIR points at a throwaway directory so
// persisted enable/disable state cannot skew the extension count between runs.
//
//   bun scripts/bench/startup.mjs            # human-readable table
//   bun scripts/bench/startup.mjs --json     # machine-readable, for diffing
//   bun scripts/bench/startup.mjs --runs 10  # more samples (default 5)
//
// Report the median. The mean is dominated by the first cold run; the spread
// between min and max is the honest error bar on a laptop.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const runsIndex = args.indexOf("--runs");
const RUNS = runsIndex >= 0 ? Number(args[runsIndex + 1]) : 5;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(samples) {
  return {
    medianMs: Number(median(samples).toFixed(1)),
    minMs: Number(Math.min(...samples).toFixed(1)),
    maxMs: Number(Math.max(...samples).toFixed(1)),
    samples: samples.length,
  };
}

/**
 * Run one measurement in a FRESH process.
 *
 * In-process repetition would measure a warm module cache, which is not what
 * "startup" means. Each sample pays the real import cost.
 */
function measureInChild(label, source) {
  const samples = [];
  for (let i = 0; i < RUNS; i += 1) {
    const configDir = mkdtempSync(path.join(tmpdir(), "codesurf-bench-"));
    const result = spawnSync("bun", ["-e", source], {
      cwd: REPO,
      env: { ...process.env, CODESURF_CONFIG_DIR: configDir, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 120_000,
    });
    rmSync(configDir, { recursive: true, force: true });
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "no output").trim().split("\n").slice(-6).join("\n");
      throw new Error(`${label} sample ${i + 1} failed (exit ${result.status}):\n${detail}`);
    }
    const match = result.stdout.match(/BENCH_MS=([\d.]+)/);
    if (!match) throw new Error(`${label} sample ${i + 1} printed no BENCH_MS:\n${result.stdout}`);
    samples.push(Number(match[1]));
  }
  return summarize(samples);
}

/** Time the built CLI end to end, which includes Bun's own process start. */
function measureCli() {
  const samples = [];
  for (let i = 0; i < RUNS; i += 1) {
    const configDir = mkdtempSync(path.join(tmpdir(), "codesurf-bench-cli-"));
    const started = performance.now();
    const result = spawnSync("bun", ["dist/index.js", "--help"], {
      cwd: REPO,
      env: { ...process.env, CODESURF_CONFIG_DIR: configDir, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 120_000,
    });
    const elapsed = performance.now() - started;
    rmSync(configDir, { recursive: true, force: true });
    if (result.status !== 0) throw new Error(`CLI --help failed (exit ${result.status}). Run \`bun run build\` first.`);
    samples.push(elapsed);
  }
  return summarize(samples);
}

const IMPORT_AGENT = `
const t0 = performance.now();
await import("./src/agent/agent.ts");
console.log("BENCH_MS=" + (performance.now() - t0));
`;

const IMPORT_CATALOG = `
const t0 = performance.now();
await import("./src/core/plugins/builtin/index.ts");
console.log("BENCH_MS=" + (performance.now() - t0));
`;

// The catalog's own import cost is paid before this, so the number is the
// activation work alone: manifests resolved, contributions registered, native
// fibers mounted.
const BOOTSTRAP = `
const { loadBuiltinPlugins } = await import("./src/core/plugins/builtin/index.ts");
const { bootstrapPlugins, shutdownPlugins } = await import("./src/core/plugins/loader.ts");
const modules = await loadBuiltinPlugins();
const t0 = performance.now();
await bootstrapPlugins(modules);
const elapsed = performance.now() - t0;
await shutdownPlugins();
console.log("BENCH_MS=" + elapsed);
`;

const SNAPSHOT = `
const { loadBuiltinPlugins } = await import("./src/core/plugins/builtin/index.ts");
const { bootstrapPlugins, shutdownPlugins } = await import("./src/core/plugins/loader.ts");
const { getRegistrySnapshot } = await import("./src/core/plugins/registry.ts");
await bootstrapPlugins(await loadBuiltinPlugins());
const t0 = performance.now();
for (let i = 0; i < 1000; i += 1) getRegistrySnapshot();
const elapsed = performance.now() - t0;
await shutdownPlugins();
console.log("BENCH_MS=" + elapsed);
`;

const COUNTS = `
const { loadBuiltinPlugins } = await import("./src/core/plugins/builtin/index.ts");
const { bootstrapPlugins, shutdownPlugins } = await import("./src/core/plugins/loader.ts");
const { getRegistrySnapshot } = await import("./src/core/plugins/registry.ts");
const modules = await loadBuiltinPlugins();
await bootstrapPlugins(modules);
const snapshot = getRegistrySnapshot();
console.log("BENCH_COUNTS=" + JSON.stringify({
  catalogEntries: modules.length,
  activeExtensions: snapshot.extensions.filter((e) => e.active).length,
  commands: snapshot.commands.length,
  tools: snapshot.tools.length,
  models: snapshot.models.length,
  settings: snapshot.settings.length,
}));
await shutdownPlugins();
console.log("BENCH_MS=0");
`;

function readCounts() {
  const configDir = mkdtempSync(path.join(tmpdir(), "codesurf-bench-counts-"));
  const result = spawnSync("bun", ["-e", COUNTS], {
    cwd: REPO,
    env: { ...process.env, CODESURF_CONFIG_DIR: configDir, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 120_000,
  });
  rmSync(configDir, { recursive: true, force: true });
  const match = result.stdout.match(/BENCH_COUNTS=(.+)/);
  return match ? JSON.parse(match[1]) : null;
}

const measurements = {
  "import: agent module graph": measureInChild("import-agent", IMPORT_AGENT),
  "import: built-in catalog": measureInChild("import-catalog", IMPORT_CATALOG),
  "bootstrapPlugins()": measureInChild("bootstrap", BOOTSTRAP),
  "getRegistrySnapshot() x1000": measureInChild("snapshot", SNAPSHOT),
  "built CLI --help (process)": measureCli(),
};

const report = {
  runs: RUNS,
  bun: process.versions.bun ?? "unknown",
  platform: `${process.platform}-${process.arch}`,
  counts: readCounts(),
  measurements,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`CodeSurf startup benchmark — bun ${report.bun}, ${report.platform}, ${RUNS} runs each\n`);
  const width = Math.max(...Object.keys(measurements).map((k) => k.length));
  console.log(`${"measurement".padEnd(width)}   median      min      max`);
  console.log("-".repeat(width + 28));
  for (const [name, m] of Object.entries(measurements)) {
    console.log(
      `${name.padEnd(width)}  ${String(m.medianMs).padStart(7)}  ${String(m.minMs).padStart(7)}  ${String(m.maxMs).padStart(7)}`,
    );
  }
  if (report.counts) {
    console.log(`\ncontributions: ${JSON.stringify(report.counts)}`);
  }
}

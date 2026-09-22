#!/usr/bin/env bun
// Rendering and streaming replay benchmark.
//
// The companion to startup.mjs, and the fixture the migration plan's phase 4
// depends on: it asks for "long transcript streaming latency, viewport
// frame/update counts and listener/child-process counts using a fixed local
// replay fixture", with no network and no credentials.
//
// Everything is deterministic. The transcript is a checked-in fixture, the
// renderer runs in `testing` mode against an in-memory stdout, and no provider
// is contacted — the stream is replayed from the fixture's own chunks. Two runs
// on the same machine differ only by scheduling noise.
//
//   bun scripts/bench/replay.mjs             # human-readable
//   bun scripts/bench/replay.mjs --json      # machine-readable, for diffing
//   bun scripts/bench/replay.mjs --runs 5    # more samples (default 3)
//
// Report the median. The min-max spread is the honest error bar.

import { createCliRenderer } from "@opentui/core";

// The renderer captures `console`, so results go to stderr — it is the only
// stream guaranteed to survive a live renderer in the same process.
const say = (line = "") => process.stderr.write(`${line}\n`);

import { Writable } from "node:stream";
import { buildTranscript, FIXTURE_ID, LONG_ANSWER, streamChunks } from "./fixtures/transcript.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const runs = Number(args[args.indexOf("--runs") + 1]) || 3;

/**
 * A TTY-shaped sink so the renderer starts without a real terminal.
 *
 * Deliberately not counting bytes: `testing: true` suppresses terminal output,
 * so any byte count here is a constant zero — a number that cannot move is
 * worse than no number.
 */
function nullStdout() {
  const stream = new Writable({
    write(_chunk, _enc, done) {
      done();
    },
  });
  Object.assign(stream, { columns: 120, rows: 40, isTTY: true });
  return stream;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the renderer stops producing frames — i.e. the tree is drawn. */
async function settleFrames(renderer, quietMs = 60) {
  let previous = -1;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { frameCount } = renderer.getStats();
    if (frameCount === previous) return;
    previous = frameCount;
    await sleep(quietMs / 4);
  }
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

/**
 * Replay one transcript through a real renderer.
 *
 * Measures what the plan asks for: how long a streamed answer takes to apply
 * delta by delta, how many frames the renderer actually produced, and what the
 * process was holding when it settled.
 */
async function replayOnce() {
  const stdout = nullStdout();
  const renderer = await createCliRenderer({
    stdout,
    testing: true,
    gatherStats: true,
    exitOnCtrlC: false,
    useMouse: false,
    // In-process render loop: a worker thread would put the frames this is
    // trying to count on the other side of a channel.
    useThread: false,
    targetFps: 60,
  });

  const { TextRenderable, BoxRenderable } = await import("@opentui/core");
  const root = new BoxRenderable(renderer, { id: "replay-root", flexDirection: "column" });
  renderer.root.add(root);

  const transcript = buildTranscript();
  const listenersBefore = process.listenerCount("exit") + process.listenerCount("SIGINT");

  // ── Static transcript: cost of drawing a long history at once ──────────────
  const staticStart = performance.now();
  for (const [index, entry] of transcript.entries()) {
    const text = entry.content ?? entry.output ?? "";
    root.add(new TextRenderable(renderer, { id: `entry-${index}`, content: text }));
  }
  renderer.requestRender();
  await settleFrames(renderer);
  const staticMs = performance.now() - staticStart;

  // ── Streaming: one answer applied delta by delta ───────────────────────────
  const chunks = streamChunks(LONG_ANSWER);
  const streaming = new TextRenderable(renderer, { id: "streaming", content: "" });
  root.add(streaming);

  const deltas = [];
  let accumulated = "";
  const streamStart = performance.now();
  let firstChunkMs = null;
  for (const chunk of chunks) {
    const t = performance.now();
    accumulated += chunk;
    streaming.content = accumulated;
    renderer.requestRender();
    await sleep(0);
    const elapsed = performance.now() - t;
    deltas.push(elapsed);
    if (firstChunkMs === null) firstChunkMs = performance.now() - streamStart;
  }
  const streamMs = performance.now() - streamStart;

  // ── Idle: what the renderer does when nothing changes ──────────────────────
  renderer.resetStats();
  const idleStart = process.cpuUsage();
  await sleep(500);
  const idleCpu = process.cpuUsage(idleStart);
  const idleStats = renderer.getStats();

  const stats = renderer.getStats();
  const result = {
    staticMs,
    streamMs,
    firstChunkMs,
    deltaP50: percentile(deltas, 0.5),
    deltaP95: percentile(deltas, 0.95),
    deltaMax: Math.max(...deltas),
    chunks: chunks.length,
    entries: transcript.length,
    // Frames the renderer produced while idle: should be ~0 with nothing dirty.
    idleFrames: idleStats.frameCount,
    idleCpuMs: (idleCpu.user + idleCpu.system) / 1000,
    rssMb: process.memoryUsage().rss / 1024 / 1024,
    listenersLeaked: process.listenerCount("exit") + process.listenerCount("SIGINT") - listenersBefore,
    frameTimeAvg: stats.averageFrameTime,
  };

  renderer.destroy();
  return result;
}

const samples = [];
for (let i = 0; i < runs; i += 1) samples.push(await replayOnce());

const pick = (key) => median(samples.map((s) => s[key]));
const summary = {
  fixture: FIXTURE_ID,
  runs,
  entries: samples[0].entries,
  streamChunks: samples[0].chunks,
  staticRenderMs: pick("staticMs"),
  streamTotalMs: pick("streamMs"),
  firstChunkMs: pick("firstChunkMs"),
  perDeltaP50Ms: pick("deltaP50"),
  perDeltaP95Ms: pick("deltaP95"),
  perDeltaMaxMs: pick("deltaMax"),
  idleFramesIn500ms: pick("idleFrames"),
  idleCpuMs: pick("idleCpuMs"),
  rssMb: pick("rssMb"),
  listenersLeaked: Math.max(...samples.map((s) => s.listenersLeaked)),
};

if (asJson) {
  say(JSON.stringify({ summary, samples }, null, 2));
} else {
  const row = (k, v, unit = "") => say(`  ${k.padEnd(24)} ${typeof v === "number" ? v.toFixed(2) : v}${unit}`);
  say(`\nreplay — fixture ${summary.fixture}, ${runs} runs, median\n`);
  row("transcript entries", summary.entries);
  row("static render", summary.staticRenderMs, " ms");
  row("stream total", summary.streamTotalMs, " ms");
  row("first chunk", summary.firstChunkMs, " ms");
  row("per-delta p50", summary.perDeltaP50Ms, " ms");
  row("per-delta p95", summary.perDeltaP95Ms, " ms");
  row("per-delta max", summary.perDeltaMaxMs, " ms");
  row("idle frames / 500ms", summary.idleFramesIn500ms);
  row("idle CPU", summary.idleCpuMs, " ms");
  row("RSS", summary.rssMb, " MB");
  row("listeners leaked", summary.listenersLeaked);
  say();
}

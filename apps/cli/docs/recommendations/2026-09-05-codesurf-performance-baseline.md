# CodeSurf startup performance baseline — 2026-09-05

Measured with `scripts/bench/startup.mjs`, which the migration plan's Phase 0
asks for: a repeatable, credential-free fixture so before/after numbers compare
like for like. Every sample runs in a **fresh process** with its own throwaway
`CODESURF_CONFIG_DIR`, because in-process repetition would measure a warm
module cache rather than startup, and persisted enable/disable state would
otherwise change the number of extensions activated between runs.

```
bun scripts/bench/startup.mjs            # table
bun scripts/bench/startup.mjs --json     # machine-readable, for diffing
bun scripts/bench/startup.mjs --runs 10  # more samples
```

## Baseline

Machine: Apple silicon (darwin-arm64), Bun 1.4.0, 5 runs per measurement,
repository at commit `9de6ae4` with the native `/context` plugin in place.
Report the median; min and max are the honest error bar on a laptop.

| Measurement | Median (ms) | Min | Max |
| --- | ---: | ---: | ---: |
| import: agent module graph | 215.6 | 181.9 | 468.1 |
| import: built-in catalog | 281.6 | 273.3 | 301.3 |
| `bootstrapExtensions()` | 23.0 | 21.0 | 24.3 |
| `getRegistrySnapshot()` × 1000 | 0.1 | 0.1 | 0.2 |
| built CLI `--help` (whole process) | 277.1 | 273.4 | 288.9 |

Contributions after boot: 48 catalog entries, 36 extensions active, 58
commands, 50 tools, 30 models, 25 settings.

## What the numbers say

**The catalog import dominates startup, and it is mostly waste.** Importing
`builtin/index.ts` costs ~282 ms, while actually activating everything costs
~23 ms — an order of magnitude less. All 48 built-ins are imported on every
launch, but only 36 activate; the twelve disabled ones (chiefly providers, each
pulling its own SDK) pay full import cost to do nothing. This is the measured
evidence for the plan's P2 finding that the built-in catalog should become a
declarative metadata catalog with dynamic imports. The conversion waves make
that fix possible: a native plugin's manifest can be read without importing its
implementation.

**Registry snapshot reads are free.** A thousand `getRegistrySnapshot()` calls
cost 0.1 ms in total, so the plan's P2 registry concern is about *notification
and identity churn on mutation*, not read cost. Any future work there needs a
different measurement — notification and re-render counts under a mutation
workload — and should not be justified by snapshot read time.

**Extension activation is not currently a startup problem.** 23 ms across 36
extensions is ~0.6 ms each. If a conversion wave makes this materially worse,
that is a regression worth investigating; on these numbers it is not where
startup time lives.

## Honest limits of this fixture

These are cold-start and boot costs only. The benchmark does **not** measure
long-transcript streaming latency, viewport frame or update counts, idle CPU,
or listener and child-process counts over time — all of which the plan also
asks for and all of which need a running TUI with a replay fixture. Nothing
here is evidence about rendering performance, and no claim is made about it.

The `import: agent module graph` maximum (468 ms against a 216 ms median) is a
first-run outlier from filesystem cache effects; treat single runs of that row
with suspicion and prefer `--runs 10` when comparing.


## Rendering and streaming replay (2026-09-06)

`scripts/bench/replay.mjs` (`bun run bench:replay`) is the fixed local replay
fixture phase 0 specifies and phase 4 was blocked on. It was missing, which is
why the rendering phase never started.

It is deterministic by construction: the transcript is a checked-in fixture
(`scripts/bench/fixtures/transcript.mjs`, 36 entries / ~24 KB, no randomness, no
timestamps), the renderer runs in `testing` mode against a TTY-shaped null sink,
and the stream is replayed from the fixture's own uneven chunks. No network and
no credentials, so two runs differ only by scheduling noise.

Median of 5 runs, MacBook, 120x40:

| Measure | Value |
| --- | --- |
| Static render, 36-entry transcript | 50.3 ms |
| Stream total, 46 deltas | 54.9 ms |
| Time to first chunk | 1.15 ms |
| Per-delta p50 / p95 / max | 1.17 / 1.28 / 1.98 ms |
| Idle frames per 500 ms | 1 |
| Idle CPU per 500 ms | 3.5 ms (~0.7%) |
| RSS | 76.8 MB |
| Listeners leaked per replay | 0 |

What these say, stated carefully because the plan forbids invented throughput
claims:

- **Streaming is not the reported problem.** A delta costs ~1.2 ms at p50 and
  under 2 ms at the worst sample, on a transcript longer than most sessions.
  There is no per-delta cliff here.
- **Idle is genuinely idle.** One frame per 500 ms and ~0.7% CPU means the
  renderer is not spinning when nothing changes, which is the failure mode the
  "~2s freeze" reports would have implied. That symptom was separately traced to
  un-memoized provider CLI checks (`execFileSync`) on the render path and fixed;
  this fixture is the standing check that it has not come back.
- **Nothing leaks per replay.** Listener count returns to its starting value.

Two metrics the plan asks for are deliberately absent rather than faked:
terminal byte and write counts. `testing: true` suppresses terminal output, so
they are a constant zero — a number that cannot move is worse than no number.
Measuring real terminal writes needs a PTY harness, which is a separate tool.

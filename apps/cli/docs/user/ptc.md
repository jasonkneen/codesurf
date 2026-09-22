# Programmatic Tool Calls (PTC)

PTC is a **presentation mode** for how the model reaches tools. Instead of the
native wire tool list, the model writes a small program (`run_code`) that calls
your native tools as bindings — through the same approval + loop-guard path.

## Modes

| Mode | What the model sees |
|---|---|
| `native` (default) | your native tool set |
| `code` | **only** `run_code` + an SDK section in the system prompt; the program composes native tools |
| `both` | native tools **plus** `run_code` |

Resolution: explicit option → `setDefaultPresentation` → env
`CODESURF_TOOL_PRESENTATION` (`code`/`both`) → `native`.

## Testing PTC in the CLI

### 1. Headless — easiest (no server)

```bash
CODESURF_TOOL_PRESENTATION=code bun dist/index.js \
  --prompt "list the files here and read package.json" --max-tool-rounds 6
```

- `code` forces the model onto `run_code`.
- `both` keeps native tools beside `run_code`.
- Add `--format json` for machine-readable chunks — the clearest view of the
  `run_code` call and the tool bindings it drives.
- Requires the engine code-runtime service — headless boots it automatically.

### 2. Per-session via `serve` — use ACP or MCP

```bash
codesurf serve --port 3947 --presentation code
```

- **ACP:** session init with `presentation: "code"`.
- **MCP:** `codesurf mcp --gateway-url http://127.0.0.1:3947`, create the session
  with `presentation: "code"`.
- ⚠ **Caveat:** `/v1/chat/completions` (OpenAI-compatible) always creates
  `native` sessions — it is **not** a PTC test surface.

### 3. Interactive TUI

```bash
CODESURF_TOOL_PRESENTATION=both codesurf
```

Runs the interactive TUI with PTC enabled. `both` is recommended in the UI so you
keep normal native tool visibility while allowing programmatic calls.

### 4. No provider at all — the wire contract is pinned

```bash
bunx vitest run src/agent/turns/stream-turn-ptc.test.ts \
  src/agent/tool-presentation.test.ts
```
## Benchmarks — PTC vs native

`scripts/bench/ptc-vs-native.mjs` compares the three presentations on the same
multi-step task, headless. Same task, same model, same build — only the
presentation differs, so the delta is the presentation's effect.

```bash
bun run bench:ptc-vs-native                      # runs from source — no build needed
bun run bench:ptc-vs-native                      # table (native/code/both)
bun run bench:ptc-vs-native --json               # machine-readable
bun run bench:ptc-vs-native --runs 5             # more samples per presentation
bun run bench:ptc-vs-native --task "…"           # override the task
```

It switches presentation via `CODESURF_TOOL_PRESENTATION`; the code runtime is an
in-process host service, so `code`/`both` need no separate node. It parses the
`--format json` semantic events and reports, per presentation (median/min/max):

- **round-trips** (LLM steps), **tool calls**, **total tokens**, **wall time**

### Live runs (grok-4.3, forced-sequential task: read package.json → act on the count)

| presentation | tool-call rounds | tool calls | total tokens | wall time |
|---|---|---|---|---|
| native | 4 | 4 | 2,063 | ~55s |
| **code** | **3** | **3** | **1,268 (−39%)** | faster |
| **both** | 3 | 3 | 1,532 (−26%) | ~55s |

On the original repo-scan→summarize task the round counts were ~equal
(grok-4.3 parallel-batches), so a **forced-sequential** default task is used to
exercise the round metric. PTC cut round-trips (−25%) and total tokens
(−26…−39%) while doing the same task. As always, more samples tighten the
delta; `--runs 5` + medians for a conclusion.

Caveats:
1. **Round count = number of tool-call batches** the model emits (each distinct
   tool-calling response), counted in the turn loop (stream-turn + the
   owning-adapter session-turn path) and surfaced on the JSONL `step_finish`.
   It is NOT the ai-sdk step counter (that collapses to 1 for grok).
2. Tokens/wall vary with run-to-run model strategy; `--runs N` and median.
3. Runs from `src/index.ts` (source) so the counter is always live; dist needs
   a rebuild after turn-loop changes.

It fails loudly (e.g. `API key required`) rather than silently reporting zeros.

## Reference implementation

CodeSurf's PTC is the wire-side sibling of the DeepSeek Harness **PTC Mode
("Code Mode")** specified in `/Users/jkneen/Documents/GitHub/deepseek-harness/PTC-MODE-SPEC.md`.
A line-level audit (read-only, no files modified) against the spec's §10
checklist found the harness implementation **fully conformant**:

- **Transport** `packages/core/tools/src/ptc.ts`: two required params `code`+`description`
  (blank rejected), reserved name, full policy pipeline for sub-calls, `{logs, result?}`
  canonical output, TS/Python flavors, no-runtime degrades to TS.
- **SDK generators** `ts-types.ts`/`py-types.ts`: arg + output types, byte-deterministic
  lexicographic order, quoted keys, degrade-on-unsupported, pinned §5 instructions.
- **Presentation**: modes `native|ptc|both`, per-scope `presentAs()`, wire list is exactly
  `[run_code]` under ptc, native names denied with `ToolNotFoundError`, no-runtime /
  unknown-language fail loud, catalog-stable for caching.
- **Code-runtime seam** (worker-thread): six orthogonal failure kinds, error-as-field,
  budgets (computeMs 60k busy-ELU, maxWallMs 600k, output 64MiB, heap 512), lossless-JSON,
  null-prototype namespaces, hostile-peer hardening, teardown-to-quiescence.
- **Sub-dispatch**: same pipeline, `<parent>:code:<n>` ids, bounded parallel (default 10),
  start/settle log events, per-session deferred contexts + images.
- **Preset**: shipped `packages/preset/agent-presets/presets/ptc/` (`PTC 模式` name),
  wired with the code runtime mounted in both web-app + headless bundles.

Test status (audit ran these): **303 passed / 0 failed** across transport + SDK +
presentation + seam + both backends (incl. real-worker compute-budget kill, wall
ceiling, OOM->worker-exit, 64 MiB boundary) + a keyless headless e2e. 2 real-model
e2e tests self-skip without `DEEPSEEK_API_KEY`.

Not yet at best capability — three gaps:
1. **No Python execution backend** — `code-runtime-python` ships the fd-3 wire protocol
   codec/validators only; only `typescript` has a published runtime, so `py-types` is
   dead until a real CPython backend ships.
2. **Per-session selection is a temporary env seam** — PTC is an opt-in preset; the
   deployment default preset is `standard`, and a documented "remove the env seam once
   the web UI owns the choice per session" TODO remains; it is not a first-class session
   toggle.
3. **Real-model e2e + golden UI never ran** — need `DEEPSEEK_API_KEY` and a built web dist
   (`apps/web/tests/ptc-round.e2e.ts` + `snapshots/session/ptc-*` goldens).

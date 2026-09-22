# Test Coverage & Quality

This section audits the test suite for the contex Electron app and its sibling packages (`codesurf-daemon`, `codesurf-relay`, `electrobun` runtime). The codebase runs tests through Node's built-in `node:test` runner via a root `npm test` glob, plus one package-local `vitest` suite that is not wired into the gate. The dominant pattern in the gaps below is the same: the most regression-prone logic in the system — the streaming state machines that convert agent/SDK output into persisted timelines and renderer state — is structurally untestable or simply undriven, while the safer decision paths around it are well covered. A secondary theme is duplication: several pure-logic helpers exist in two or three copies (daemon vs. local IPC vs. renderer), and no test asserts the copies agree, so they can drift silently.

Two cross-cutting clusters intersect this dimension and are owned by other sections:

- **Discovery-graph geometry duplication** (cluster `C1`, finding `test-03`) — the duplication root cause is owned elsewhere. See also: the **duplication** section owns this.
- **Pure logic trapped in Electron-coupled `chat.ts`** (cluster `C6`, finding `test-08`) — the boundary violation that causes the testability gap is owned elsewhere. See also: the **separation** section owns this.

## Findings

| ID | Title | Severity | Effort | Files |
| --- | --- | --- | --- | --- |
| `test-01` | Daemon chat-job streaming/aggregation loop is untested (only the result-message path runs) | High | M | `packages/codesurf-daemon/bin/chat-jobs.mjs` |
| `test-02` | Renderer streaming state machine (`useChatStreamHandler`) has zero tests | High | M | `src/renderer/src/hooks/useChatStreamHandler.ts` |
| `test-03` | Canvas discovery logic duplicated in `App.tsx` and `discovery-graph-impl.ts`, neither tested | Medium | M | `src/renderer/src/App.tsx`, `src/renderer/src/workers/discovery-graph-impl.ts` |
| `test-04` | `agent-stream.ts` SSE/NDJSON parsers untested; UTF-8 multibyte chunk-split corrupts text | Medium | M | `src/main/agent-stream.ts` |
| `test-05` | Migration 004 FTS5 search triggers (`job_search` / `timeline_search`) never exercised | Medium | M | `src/main/db/migrations/004_job_index.ts`, `test/electrobun-runtime-db.test.mjs` |
| `test-06` | `codesurf-relay` scheduler tests exist but are not run by root `npm test` (the CI command) | Medium | S | `package.json`, `packages/codesurf-relay/package.json`, `.github/workflows/release-on-tag.yml` |
| `test-07` | Shared assertion helper (`node-expect.ts`) uses loose matchers; `toBeNull`/`toBeUndefined` interchangeable | Medium | S | `test/node-expect.ts` |
| `test-08` | Local-execution checkpoint safety helpers in `chat.ts` duplicate the daemon's tested copies but are untested | Medium | M | `src/main/ipc/chat.ts`, `packages/codesurf-daemon/bin/chat-jobs.mjs` |

---

### `test-01` — Daemon chat-job streaming/aggregation loop is untested (High)

**Problem.** `createChatJobManager` has good coverage for the `canUseTool` checkpoint/permission decision path, but the actual SDK message stream loop — which converts Claude streaming deltas into `appendEvent` timeline events (text, thinking, thinking_start, tool_start, tool_summary) — is never driven by any test. The mocked `claudeQuery` generators in the only consuming test emit a single `result` message, so the entire text/thinking/tool aggregation, sequence numbering, and timeline-event emission for normal streamed turns is unverified. A regression here (wrong event-type mapping, dropped thinking deltas, `tool_use` not paired to `tool_start`) would corrupt every job's persisted timeline and the renderer view that reads it, with no test failing.

**Evidence.** The `for await (const msg of q)` loop in `packages/codesurf-daemon/bin/chat-jobs.mjs` (lines ~1072-1136) handles at least these branches:

- `stream_event` envelope → `event.type === 'content_block_delta'` with `text_delta` → `text` (line ~1082), `thinking_delta` → `thinking` (~1084)
- `stream_event` → `content_block_start` with `tool_use` → `tool_start` (~1090-1094), `thinking` → `thinking_start` (~1096)
- top-level `assistant` tool_use block → `tool_use` (~1106-1112)
- top-level `tool_use_summary` → `tool_summary` (~1117)
- top-level `tool_progress` → `tool_progress` (~1121-1125)
- top-level `result` → `done` (~1128)

All six tests in `test/daemon/chat-jobs-claude-checkpoints.test.mjs` (the only file using `createChatJobManager`) mock `claudeQuery` to yield ONLY a single `{type:'result', ...}` message (verified at lines 87-93, 153-159, 219-225, 288-294, 340-346, 397-403). The entire stream-loop aggregation path is therefore never driven. The other test touching `stream_event` (`electrobun-chat-streams.test.mjs`) exercises a *different* parser — `parseClaudeStreamJsonLine` in `electrobun/bun/chat-streams.ts` — with opposite thinking-delta semantics (it drops thinking deltas; the daemon emits them), so it cannot catch a daemon-side regression.

**Recommendation.** Add a unit test (or tests) that drive `createChatJobManager` with a `claudeQuery` generator emitting a realistic ordered message sequence and assert the persisted timeline via the existing `readTimeline` helper. Be precise about message nesting: `content_block_delta` (text_delta, thinking_delta, input_json_delta) and `content_block_start` (tool_use, thinking) are nested inside a top-level `{type:'stream_event', event:{...}}` envelope, whereas `tool_use_summary`, `tool_progress`, `assistant`, and `result` are top-level `{type:...}` messages. A good sequence: `stream_event(content_block_delta text_delta)` → `stream_event(content_block_delta thinking_delta)` → `stream_event(content_block_start tool_use)` → `tool_use_summary` → `result`. Assert the timeline contains ordered events of type `text`, `thinking`, `tool_start` (with correct `toolName`/`toolId`), `tool_summary`, then `done`, with monotonic sequence numbers. Add a malformed-message case (missing delta, unknown `msg.type`) asserting the job still completes (emits `done`) without throwing.

**Effort.** M.

**Verifier critique.** Confirmed accurate at all cited locations; the loop handles exactly the branches described and every line ref matches. The finding correctly attributes `tool_start` to `content_block_start`, not the assistant branch. Sequence numbering lives in `appendEvent` (line ~758) and *is* exercised by the checkpoint-path tests, but the stream-loop-originated `appendEvent` calls are not. Feasibility is clean: `createChatJobManager` already accepts an injectable `claudeQuery` generator (used by all existing tests) and `readTimeline` already exists. One clarification for whoever writes the test: wire the mock generator at the correct nesting — `content_block_*` events go inside a `stream_event` envelope (accessed via `msg.event.type`), while `tool_use_summary` / `tool_progress` / `assistant` / `result` are top-level branches.

---

### `test-02` — Renderer streaming state machine (`useChatStreamHandler`) has zero tests (High)

**Problem.** This hook aggregates low-level IPC stream chunks into `ChatMessage` state. It is a complex reducer-style state machine with index-finding (`findIndex`/`findLastIndex` by `toolId` or fallback heuristics), out-of-order sequence rejection, synthetic-ID generation for missing `thinkingId`/`toolId`, and in-place tool/thinking block merges. No test references `useChatStreamHandler` or `mergeToolBlockDuplicate`. A subtle regression (e.g. `findLastIndex` picking the wrong block, or a sequence guard off-by-one) silently merges streamed output into the wrong tool/thinking block with no test catching it.

**Evidence.** In `src/renderer/src/hooks/useChatStreamHandler.ts`:

- `mergeToolBlockDuplicate` (lines 6-20) — including a running→done downgrade guard
- sequence dedup (lines 61-65)
- synthetic IDs `think-${Date.now()}` / `tool-${Date.now()}` (lines 84, 107, 121)
- `tool_summary` uses `blocks.findLastIndex(b => b.status==='done' && !b.summary)` with a fallback to running blocks (lines 181-183)
- `tool_use` matches by `toolId` OR `name===toolName && status==='running'` (lines 160-162)
- `thinking` creates synthetic blocks when the target id is not found (lines 106-109)

A grep for `useChatStreamHandler|mergeToolBlock|onChunk` across `test/` returns nothing. The closest documentation of the risk is the parity requirement in `.planning/chat-tile-v2-parity.md:771` ("Sequence-guard preserved — out-of-order/duplicate stream events ignored"). A runtime safety net, `normalizeMessageStructure` in `src/renderer/src/components/chat/messageNormalization.ts:112-153`, dedupes duplicate tool blocks by `block.id` — but it cannot recover content merged into the *wrong* block (a different id from a bad `findLastIndex`/`findIndex`) nor fix a sequence off-by-one, and it is itself untested.

**Recommendation.** Two adjustments to the obvious "extract and test" plan:

1. **Do NOT extract `mergeToolBlockDuplicate` into a new module** — it is ALREADY exported from `src/renderer/src/components/chat/messageNormalization.ts:96-110`, and the copy in `useChatStreamHandler.ts:6-20` is a byte-identical duplicate. The correct move is to delete the hook's local copy, import the existing export, then test that one shared function. (The two copies will otherwise drift independently — a latent bug in itself.)
2. **Then extract the per-event message transforms** (the bodies inside `updateLast` for `text`/`thinking_start`/`thinking`/`tool_start`/`tool_input`/`tool_use`/`tool_summary`/`block_stop`/`done`) into a pure `reduceStreamEvent(message, event) => ChatMessage` in the same `chat/` module. These branches operate only on `shared/chat-types` and have no coupling to React refs or setters. The genuinely effectful branches stay in the hook (the sequence guard at lines 61-65 that mutates `lastJobSequenceRef`, the permission-map setters at lines 231-241/253-279, session/text/`queueStreamText`, and `bus.publish`).

Unit tests against the pure reducer: (a) `tool_start` then `tool_summary` with matching `toolId` merges; (b) `tool_summary` with no `toolId` selects latest done-without-summary via `findLastIndex`, else falls back to last running; (c) thinking delta with missing `thinkingId` appends to active block (synthetic-ID path); (d) `mergeToolBlockDuplicate` does not downgrade an existing `done` to `running`; (e) `tool_use` with no `toolId` matches by name+running. Separately, give the sequence guard (lines 61-65) a thin test since it is the documented out-of-order defense.

**Effort.** M.

**Verifier critique.** Code evidence is accurate at every cited location, and zero coverage is confirmed (the only references to `useChatStreamHandler`/`mergeToolBlockDuplicate` are the consumer `ChatTile.tsx` and `messageNormalization.ts`). Two corrections to the original framing: (1) the claim that an architecture digest "explicitly flags this path as risking state corruption" is overstated — no such digest flag exists; the real documentation is the parity checklist at `.planning/chat-tile-v2-parity.md:771`. (2) `mergeToolBlockDuplicate` is already exported, so the fix is consolidation, not a third extraction. High severity holds: the corruption risk is independently corroborated by the hand-written `normalizeMessageStructure` safety net plus the parity requirement, and that net only catches the narrow duplicate-id failure mode while remaining untested itself.

---

### `test-03` — Canvas discovery logic duplicated, neither copy tested (Medium)

Part of cluster `C1` (discovery-graph geometry duplication). See also: the **duplication** section owns this — the root cause, the consolidation plan, and the across-threshold divergence analysis live there. The notes below are scoped to the test gap only.

**Problem (test-scoped).** The O(n²) tile-capability/discovery code exists in two copies (`App.tsx` and the worker's `discovery-graph-impl.ts`) with a byte-identical capability table, and no test references either copy or asserts they agree.

**Evidence.** `App.tsx:553-563` and `discovery-graph-impl.ts:94-101` contain identical capability mappings. A grep for `discovery-graph-impl|runDiscoveryPipeline|getTileSpatialReference|findDiscoveryConnections` across `test/` returns nothing. `connection-graph.test.ts` covers `cascadeConnectionGraph`/`addAssociatedConnectionGroups` from `shared/connectionGraph.ts`, but NOT `discovery-graph-impl`'s pairwise finder or capability table.

**Recommendation (test-scoped).** Add unit tests against `discovery-graph-impl` directly: a capability link within vs. outside `getDiscoveryMaxDistance`; an `ext:` tile with registered actions yielding prefixed tool names; and a `runDiscoveryPipeline` + `deserializeDiscoveryOutput` Set/Map round-trip.

**Effort.** M.

**Verifier note.** Severity lowered High → Medium: the finding's headline mechanism (graph renders differently above/below the 10-tile threshold) is false — both paths use `runDiscoveryPipeline`; the real, narrower risk is the locked/associated connection path that still calls the duplicated local helpers.

---

### `test-04` — `agent-stream.ts` SSE/NDJSON parsers untested; UTF-8 multibyte chunk-split corrupts text (Medium)

**Problem.** Four near-identical stream parsers normalize agent output into `StreamEvent`s. They are live (`parseClaudeStream` is called from `chat.ts:1558`, `getStreamParser` from `stream.ts:43`) but untested. Two concrete defects have no guard: (1) `buffer += chunk.toString()` with no encoding and no incremental decoder means a UTF-8 multibyte character split across two TCP chunks decodes as two replacement characters, corrupting streamed text — the line-buffer logic only handles `\n` splits, not byte splits. (2) Empty `catch` blocks silently swallow any JSON parse error, so a provider format change produces silent text loss rather than a surfaced error.

**Evidence.** In `src/main/agent-stream.ts`: `parseClaudeStream` (29-68), `parseCodexStream` (72-107), `parsePiStream` (111-139), `parseGenericStream` (143-150), `getStreamParser` (152-159). Lines 33/76/114 do `buffer += chunk.toString()` (default utf8, but per-chunk, not via `StringDecoder`), then split on `'\n'`. The catch blocks at lines 62, 101, 133 are `catch { /* non-JSON */ }`. A grep for `agent-stream` across `test/` returns nothing. Confirmed callers: `chat.ts:1558` `parseClaudeStream(req.cardId, res)`; `stream.ts:43` `getStreamParser(req.agentId)`.

**Recommendation.** Refactor the parsers to accept a string-yielding source (or factor the buffer-and-dispatch core out of the `res.on('data')` wiring) so the parse logic is testable without a live `IncomingMessage`. Then test: Claude `content_block_delta` `text_delta` → `text` event; `thinking_delta` → `thinking`; `[DONE]` and `message_stop` → `done`; a data line split across two chunk boundaries reassembles into one event; and crucially a multibyte char (e + combining mark, or an emoji) split across chunks decodes intact (will fail today, proving the bug). Use `node:string_decoder.StringDecoder` to fix the multibyte bug.

**Effort.** M.

---

### `test-05` — Migration 004 FTS5 search triggers never exercised (Medium)

**Problem.** The entire purpose of migration 004 is full-text search across job task labels, prompts, and errors via FTS5 virtual tables maintained by `AFTER INSERT/UPDATE/DELETE` triggers. The only test inserts into `job_index` and reads it back via the IPC list shape, but never queries `job_search MATCH ...` or `timeline_search MATCH ...`. The trigger SQL that concatenates `task_label`/`initial_prompt`/`error_text` into the search index, and the update/delete sync triggers, are completely unverified. A typo in a trigger (wrong column coalesce, missing rowid sync on update) ships silently because search results simply come back empty/stale, which no assertion checks. The production `better-sqlite3` path (`src/main/db/index.ts` `runMigrations`) has no test at all — only the electrobun `sql.js` runtime is tested.

**Evidence.** In `src/main/db/migrations/004_job_index.ts`: triggers `job_search_ai/au/ad` (lines 120-140) and `timeline_search_ai/ad` (142-151). A grep for `MATCH|job_search|fts5|timeline_search` across `test/` returns only `test/electrobun-runtime-db.test.mjs`, where `job_search` appears solely in the expected-table-list assertion (line 44). No INSERT-then-MATCH test exists. A grep for `db/index|runMigrations|seedDeviceId|applyPragmas` across `test/` returns nothing.

**Recommendation.** Add a test: insert a `job_index` row with a distinctive `task_label`/`error_text`, then `SELECT job_id FROM job_search WHERE job_search MATCH 'distinctiveword'` and assert it returns the row; UPDATE the row's `task_label` and assert the old term no longer matches and the new one does; DELETE and assert no match. Mirror for `timeline_event_index`/`timeline_search`. Run it against both the electrobun runtime and, ideally, the `better-sqlite3` `runMigrations` path so production migration ordering/idempotency is also covered.

**Effort.** M.

---

### `test-06` — `codesurf-relay` scheduler tests exist but are not run by root `npm test` (Medium)

**Problem.** The relay runtime (`RelayRuntime.schedule`, `executorFactory`, `RuntimeAgentState` in `runtime.ts`) is the agent turn scheduler central to multi-agent coordination. It has a real vitest suite covering spawn+initial-task, run-turn-on-message, emit-error-on-failure, timeout, and parse-output. But these run via `vitest run` scoped to the package, and the root `npm test` glob does not include `packages/**`. CI runs root `npm test`, with no root vitest dependency/config and no `workspaces` field — so a regression in the relay execution loop passes CI green even though tests for it exist on disk.

**Evidence.** Root `package.json:22` `test` globs only `test/` subdirs (`test/*.test.ts test/*.test.mjs test/main/* test/sidebar/* test/daemon/*`). `packages/codesurf-relay/package.json:11` has its own `test: vitest run` and a local vitest install at `packages/codesurf-relay/node_modules/.bin/vitest`. Root has no vitest (`node_modules/.bin/vitest` missing, no vitest in root `package.json`, no `vitest.config`) and no `workspaces` field. The only CI workflow, `.github/workflows/release-on-tag.yml:72`, calls `npm test`. `runtime.test.ts` confirms `class RelayRuntime`, `schedule()`, `RuntimeAgentState`, `executorFactory`.

**Recommendation.** Wire the package tests into the gate: either add `"test:relay": "npm --prefix packages/codesurf-relay test"` and chain it into the root `test` script (or a `test:all`), or add a `workspaces` field and run `npm test --workspaces`. Then update `release-on-tag.yml` to run the combined command. Confirm vitest is installable in CI (the devDependency is present in the package).

**Effort.** S.

---

### `test-07` — Shared assertion helper uses loose matchers; `toBeNull`/`toBeUndefined` interchangeable (Medium)

**Problem.** Every `.ts` test in the suite (`browser-evidence`, `large-content`, `connection-graph`, `session-title-generation`, etc.) asserts through this jest-style shim. Its matchers use loose comparisons: `toBe` maps to `assert.equal` (`==`) not `strictEqual`, and `toEqual` maps to `deepEqual` not `deepStrictEqual` — so `expect('2').toBe(2)` passes and type-coercion regressions go undetected. Worse, because `null == undefined` is true under loose equality, `toBeNull()` and `toBeUndefined()` are functionally identical: a test asserting a value is `null` also passes when it is `undefined` (and vice versa). This weakens exactly the null/undefined-boundary assertions that matter most for defensive-coding regressions.

**Evidence.** In `test/node-expect.ts`: line 20 `assert.equal(actual, expected)` (toBe); line 23 `assert.deepEqual(actual, expected)` (toEqual); line 26 `assert.equal(actual, null)` (toBeNull); line 29 `assert.equal(actual, undefined)` (toBeUndefined). `node:assert/strict` is imported, but `assert.equal`/`deepEqual` on the strict namespace are still the loose variants (strict only changes the default bare `assert()`); the strict equivalents `strictEqual`/`deepStrictEqual` are not used.

**Recommendation.** Change `toBe` to `assert.strictEqual`, `toEqual` to `assert.deepStrictEqual`, `toBeNull` to `assert.strictEqual(actual, null)`, `toBeUndefined` to `assert.strictEqual(actual, undefined)`. Run the suite; fix any tests that were silently relying on coercion (those failures are real latent gaps). This is a one-file change that strengthens all `.ts` tests at once.

**Effort.** S.

---

### `test-08` — Local-execution checkpoint safety helpers in `chat.ts` duplicate the daemon's tested copies but are untested (Medium)

Part of cluster `C6` (pure logic trapped in Electron-coupled `chat.ts`). See also: the **separation** section owns this — the boundary violation that makes these helpers unimportable, and the shared-module extraction plan, live there. The notes below are scoped to the test gap only.

**Problem (test-scoped).** The checkpoint-before-destructive-write helpers on the local/in-process execution path (`createRuntimeCheckpoint` + `allowToolWithCheckpoint`) are not exported and have no tests, so the local checkpoint safety net (snapshot a file before the agent overwrites it) is unverified — while its daemon twin is covered.

**Evidence.** In `src/main/ipc/chat.ts`: `buildCheckpointLabel` (328), `extractAnthropicCheckpointPaths` (334), `sanitizeToolOutputText` (665), `createRuntimeCheckpoint` (367), `allowToolWithCheckpoint` (408). The daemon equivalents in `packages/codesurf-daemon/bin/chat-jobs.mjs` (lines 217/235/117) are partially covered by `chat-jobs-claude-checkpoints.test.mjs`. A grep of `^export` in `chat.ts` shows none of these helpers are exported; the only `chat.ts`-touching tests (`agent-cli-contracts`, `chat-convention-prompts`) import from `src/main/agents/*` and assert prompt text.

**Recommendation (test-scoped).** Once consolidated into the shared module the separation section recommends, unit-test path extraction for Write/Edit/MultiEdit — including relative-path resolution against `workspaceDir` and the no-path edge case that must *deny* — and `sanitizeToolOutputText` for secret/large-output redaction.

**Effort.** M.

---

## Quick wins

- **`test-07` (S, one file):** Switch `test/node-expect.ts` to `strictEqual`/`deepStrictEqual` and distinct null/undefined assertions, then fix any tests that were leaning on coercion. Strengthens every `.ts` test at once.
- **`test-06` (S):** Add `test:relay` (or a `workspaces` run) to the root `test` script and to `release-on-tag.yml` so the relay scheduler's existing vitest suite actually gates CI.
- **`test-05` (M but mechanical):** Add INSERT-then-`MATCH` assertions for `job_search`/`timeline_search` to the existing `electrobun-runtime-db.test.mjs`; the harness is already in place, only the FTS queries are missing.
- **`test-02` consolidation half (quick, de-risks before testing):** Delete the byte-identical `mergeToolBlockDuplicate` copy in `useChatStreamHandler.ts` and import the existing export from `messageNormalization.ts`, removing a silent-drift bug independent of writing the reducer tests.

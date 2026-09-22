# CodeSurf storage and hooks targeted review — 2026-09-05

Reviewer: Hans / Astra. Product code was read only; fixes remain reserved for the requested Spark implementation. This report records two concrete findings and explicit remaining coverage. The earlier daemon report's D5 evidence was also updated at the parent's request to reflect its executed mocked scheduler reproduction.

## Coverage and evidence limits

Entire production files reviewed: `src/hooks/executor.ts` (244 lines), `src/hooks/index.ts` (128), `src/hooks/config.ts` (41), `src/storage/db.ts` (159), `src/storage/sessions.ts` (240), `src/storage/workspaces.ts` (84), `src/storage/transcript.ts` (372), `src/storage/transcript-view.ts` (45), and `src/storage/tool-results.ts` (56). These are 1,369 production lines across nine files.

Read all of `src/hooks/executor.test.ts`: its two tests cover detached spawning and sending SIGTERM on abort, not escalation or asynchronous stdin errors. Searched `src/storage/transcript.test.ts` for error-json/denied cases; no matches. Traced the producer of error-json to `src/agent/turns/helpers.ts:269–280`; that file was not fully re-reviewed in this slice.

Executed checks were isolated actual-source checks: a VM evaluation of transpiled hook executor with fake child/process/timers, and direct imports of pure tool-output functions under Bun. No shell hook subprocess was launched, no real signals were sent, and no production database was opened. These are focused reproductions, not a full test-suite run.

## SH1 — P1: Hook timeout cancels its own forced-kill escalation

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/hooks/executor.ts`. Promise settlement no longer clears the escalation timer; SIGTERM → SIGKILL (`HOOK_KILL_ESCALATION_MS`) stays armed until the child's `exit`/`close`, for both timeout and abort, and `child.killed` no longer gates signalling. Output accumulation stops after settlement. Regressions: `src/hooks/executor.test.ts` (`termination escalation`).

**Evidence:** `src/hooks/executor.ts:107–118` sends SIGTERM, installs a three-second SIGKILL timer, then calls `finish`. `finish:33–39` immediately clears `killTimer`, so escalation cannot execute. The abort handler at `120–124` also sends only SIGTERM and resolves immediately. A signal-resistant hook can therefore continue executing after the caller reports timeout or cancellation. Its output listeners remain active and can continue accumulating output.

**Executed reproduction:** Transpiled the actual executor to CommonJS with TypeScript and evaluated it with `node:vm`. Supplied an EventEmitter child, recorded process-group signals, and supplied an in-memory timer registry. Invoked a one-second timeout callback without emitting child exit. Result: `outcome: non_blocking_error`, signals `[SIGTERM]`, and `pendingEscalationTimers: 0`. No subprocess or real timer was used. This directly confirms the escalation timer is removed before it can run.

**Scenario:** A user hook or its descendant ignores SIGTERM. The hook times out; the tool/turn proceeds while the old process continues reading/writing the workspace. Repeated hooks can leak processes and retained output memory.

**Recommendation/test:** Separate promise settlement from process cleanup ownership. Keep escalation alive until verified child/process-group termination; add bounded cleanup for abort as well. Extend the existing fake-child tests: advance timeout, verify SIGTERM; leave the child alive, advance three seconds, require SIGKILL; close early and require escalation cancellation. Cover abort and a process-group descendant holding inherited pipes. Do not use `child.killed` as proof of exit when implementing escalation.

## SH2 — P2: Persisted structured tool failures lose their diagnostics; denied execution is classified as success

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/storage/tool-results.ts` (error-json and execution-denied normalized to failed ToolResults preserving diagnostics; `isOutputSuccess` treats both as failures) and `src/storage/transcript.ts` (legacy wrapper-shaped rows normalized on read). Regressions: `src/storage/tool-results.test.ts` and the `appendMessages`/`buildChatEntries` round trip in `src/storage/transcript.test.ts`.

**Evidence:** `src/storage/tool-results.ts:21–40` unwraps `json`, `text`, and `error-text` but neither `error-json` nor `execution-denied`. `isOutputSuccess:50–55` returns true for execution-denied because that type does not start with `error`. These are concrete supported formats: `src/agent/turns/helpers.ts:279` produces error-json for failed batch/provider tool results.

`src/storage/transcript.ts:191–197` stores the raw wrapper when extraction returns null. `loadStoredToolResults:350–362` later parses that wrapper and casts it directly to ToolResult, without conversion. `buildChatEntries:263–270` prefers this truthy cached object over extracting the original message. Since a wrapper has neither `success` nor `error`, a persisted structured failure becomes generic `Error` and its diagnostic is unavailable through the expected ToolResult fields.

**Executed reproduction:** Imported the actual pure helper functions with Bun. For `{type:"error-json",value:{success:false,error:"permission denied"}}`, extraction returned null. For `{type:"execution-denied",reason:"user refused"}`, extraction returned null and `isOutputSuccess` returned true. The persistence/rebuild consequence was source-traced, not executed against SQLite.

**Scenario:** A failed batch/provider tool shows a useful message live but becomes a generic Error after turn-end rebuild or session resume. A stored denied execution also receives success=1 in the result table even though the action did not execute.

**Recommendation/test:** Normalize every supported SDK output variant before persistence and when reading legacy rows; map error-json to a failed ToolResult preserving details and execution-denied to a failed/denied result preserving its reason. Add a round-trip test using `appendMessages` and `buildChatEntries` for both variants, asserting retained diagnostic and failure status. Include already-persisted wrapper-shaped rows to cover existing sessions.

## Reviewed strengths and unresolved questions

- `SessionStore` get/delete/update methods explicitly constrain session IDs by the store's workspace ID. Global listing is an explicit option; no cross-workspace mutation finding was established here.
- `appendMessages` and `appendCompaction` wrap their related writes in database transactions. Sequence allocation occurs inside the append transaction. No rollback defect was established by this source pass.
- Hook configuration loads user settings only, with repository-local hooks intentionally excluded.
- Legacy database migration copies the main file and WAL/SHM independently (`db.ts:71–79`) and treats target existence as completed migration (`56`). A concurrent legacy writer or interrupted partial migration deserves a snapshot/backup test; no live legacy database was inspected or modified, and corruption is not claimed as reproduced.
- Hook stdin has only a synchronous try/catch around `write/end`; an emitted stream error is a separate event. A mocked asynchronous EPIPE or OS fixture is needed before assigning observed impact. Output strings are unbounded; no stress measurement was performed.

## Explicitly unreviewed

Production `src/storage/migrations.ts`, `usage.ts`, `traces.ts`, `tile-state.ts`, `prompt-history.ts`, `card-id.ts`, and barrel exports; hook `types.ts` and `count.ts`; full storage test suites; all call-site authorization of low-level transcript APIs; multiprocess SQLite writer behavior; compaction algorithm correctness; legacy migration under active writes; real shell/Windows process trees; integration behavior after fixes. No full storage or hook safety certification is implied.

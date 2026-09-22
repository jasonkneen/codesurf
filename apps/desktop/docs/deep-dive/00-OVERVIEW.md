# Deep-Dive Audit — Master Overview & Roadmap

This is the entry point to a multi-dimension deep-dive audit of the CodeSurf / contex
Electron app (infinite-canvas workspace for AI agents; Electron main + React renderer +
a standalone `codesurf-daemon` agent host). Nine dimensions were audited and written up
as section files `02`–`09`; a tenth meta-pass (`10-holes.md`) records what the dimensions
structurally could not see. Every finding below carries a `file:line` anchor verified
against source; read the linked section for full evidence and recommendations.

---

## 1. Executive summary

**State of the codebase.** The core engine is coherent and the audited hotspots were the
right ones — but the audit's own framing hid its most important result. The nine dimensions
(refactor, memory, performance, reliability, testing, duplication, separation, daemon,
self-learning) contain **no security axis**, and the two most serious problems in the entire
codebase live there. Both are exploitable with **zero user interaction**:

- **RCE on workspace open.** Opening or cloning *any* repository that ships a
  `.contex/extensions/<x>/extension.json` with `"tier":"power"` and a `"main"` file causes
  the Electron main process to `require()` and run that attacker-controlled Node code —
  full `fs`/network/`child_process`, no sandbox, no consent prompt. Workspace extensions
  auto-activate (`registry.ts` passes no `defaultEnabled:false` for the workspace branch).
  See [10-holes.md → risk-01](./10-holes.md).
- **Unauthenticated local MCP server.** The MCP HTTP server binds `127.0.0.1:<random>`
  with the auth check explicitly disabled; a bearer token is generated and written to
  `~/.codesurf/mcp-server.json` but never validated, and that config file is world-readable
  (`0o644`). Any local process can read the port and drive `POST /inject`, which submits
  arbitrary commands into a terminal tile — local command execution.
  See [10-holes.md → risk-02 / risk-03](./10-holes.md).

Outside security, the codebase is fundamentally sound but carries three recurring structural
debts: **lifecycle/teardown leaks** (per-tile and per-job state is never reclaimed on delete
or shutdown), **divergent duplicate copies across the app↔daemon boundary** (the same logic
is shipped 2–5× and has already drifted, so fixes don't propagate), and **god-files that fuse
Electron IO with pure domain logic** (`chat.ts` ~4k LOC, `App.tsx` ~1700 LOC), which both
blocks unit testing and makes change risky. None of these are crises on their own; together
they are the bulk of the M/L work.

**Counts — read as two buckets.** The dimension audit and the meta-pass count separately;
the dimension `Totals` say `critical: 0` only because both criticals were found by the
meta-pass on the un-audited security axis.

| Bucket | Source | critical | high | medium | low | total |
|--------|--------|:-:|:-:|:-:|:-:|:-:|
| Dimension findings | sections 02–09 | 0 | 9 | 30 | 17 | 56 |
| Meta-pass (security/coverage) | [10-holes.md](./10-holes.md) | **2** | several | several | several | 16 |
| **Combined headline** | — | **2** | **11+** | — | — | — |

Do not report this codebase as "0 critical." It has two, and they are the story.

### Top 5 themes

1. **No security axis — and the worst lives there.** Two criticals (RCE-on-open,
   unauthenticated MCP command execution) plus a cluster of high/medium trust-boundary
   issues (world-readable token file, `codesurf-file://` exfil, plaintext generation-provider
   keys, full Chrome cookie jar injected into untrusted webviews). All in
   [10-holes.md](./10-holes.md); none were reachable by the nine dimensions.
2. **Lifecycle / teardown leaks.** Tile delete and daemon shutdown never reclaim state:
   chat session/permission maps ([mem-01](./02-memory.md)), stream handles
   ([mem-02](./02-memory.md)), bus ring buffers ([mem-03](./02-memory.md)), in-flight daemon
   jobs and their child processes ([cluster C3](#3-cross-cutting-root-cause-table)), and
   unbounded job/checkpoint artifacts ([daemon-05/06](./08-daemon.md)).
3. **Divergent duplicate copies across the app↔daemon boundary.** The dreaming engine
   ([C2](#3-cross-cutting-root-cause-table)), `atomicWriteJson` ([C4](#3-cross-cutting-root-cause-table)),
   the external-session indexer ([C5](#3-cross-cutting-root-cause-table)), and the discovery
   geometry engine ([C1](#3-cross-cutting-root-cause-table)) each exist 2–5× with no shared
   module; several have already drifted, so a fix to one copy silently does not ship.
4. **God-files fusing IO with pure logic, blocking tests.** `chat.ts` mixes `ipcMain`/
   `BrowserWindow`/`child_process`/`http`/`fs` with provider-agnostic prompt and checkpoint
   logic, forcing its test to `readFileSync`-scrape source ([C6](#3-cross-cutting-root-cause-table));
   `App.tsx` carries the inline discovery copy and the whole canvas engine ([C1](#3-cross-cutting-root-cause-table),
   [perf-01](./03-performance.md)).
5. **Testing / CI gaps on the highest-risk subsystem.** The entire `packages/codesurf-relay`
   vitest suite — the agent-coordination core flagged as highest leak risk — never executes
   anywhere (vitest declared but not installed, excluded from `npm test`), and there is **no
   PR/push CI** at all; tests only run at release-tag time. See
   [gap-02 / gap-04](./10-holes.md) and [test-01/02](./05-testing.md).

---

## 2. Prioritized roadmap

Three tiers. Items are ordered **severity-then-effort within tier**, not by dimension.

### Tier 1 — Quick wins (S effort, high value)

> **Do these first — both are S-effort and close the two worst trust-boundary holes.**

| # | What | Why | Effort | Read |
|---|------|-----|:-:|------|
| QW-1 | **Re-enable MCP auth.** Validate `Authorization: Bearer <MCP_TOKEN>` on every non-OPTIONS request to the MCP server (the token is already generated and written to config). Drop wildcard CORS; validate the `Host` header. | Closes the unauthenticated `/inject` command-execution surface (critical). | S | [risk-02](./10-holes.md) |
| QW-2 | **Lock down the token file.** Write `mcp-server.json` with `{mode:0o600}` (matching `secrets.json`); audit `permissions.json` for the same default-permission leak. | The bearer token is world-readable today; auth in QW-1 is moot if the token leaks. | S | [risk-03](./10-holes.md) |
| QW-3 | **Add PR/push CI.** New workflow on `pull_request` + push-to-main running `npm ci && npm test && typecheck`. | No CI gates merges today — tests only run at release-tag time. | S | [gap-04](./10-holes.md) |
| QW-4 | **git arg-injection guard.** Insert `--end-of-options` (or use `git switch`) before user-supplied branch names; reject leading `-`. | `git:checkoutBranch/createBranch` forward renderer input as argv. | S | [risk-05](./10-holes.md) |
| QW-5 | **Remove the hardcoded `/Users/jkneen/...` codicon path** from the `codesurf-ext://` handler; add a build-time grep gate rejecting `/Users/` in `src/`. | Dead/broken on every other machine; leaks dev dir layout into the binary. | S | [gap-05](./10-holes.md) |
| QW-6 | **Memory teardown.** Add a `chat:disposeCard(cardId)` IPC that evicts all five session maps + prunes `session-ids.json`, called from `cleanupTileResources`; drop orphaned `card:`/`ctx:` bus channels on tile cleanup; clean up `activeStreams` on renderer disconnect. | mem-01/02/03 — unbounded per-tile growth, all S, all in the same cleanup path. | S×3 | [02-memory.md](./02-memory.md) |
| QW-7 | **Canvas/IPC perf S-wins.** `viewportRef` in `onWheel` (perf-03); `LIMIT 500` on `listThreadsFromDb(null)` (perf-08); wire or delete the dead rAF batcher (perf-02); minimap viewport-only redraw (perf-09). | Cheap frame-rate and payload wins on the canvas hot path. | S×4 | [03-performance.md](./03-performance.md) |
| QW-8 | **Reliability S-wins.** Abort the relay SDK query on turn timeout (rel-03 — stops a billing leak); kill child/PTY processes on app quit (rel-02). | Stops orphaned billing and zombie agent/codex processes. | S | [04-reliability.md](./04-reliability.md) |
| QW-9 | **Daemon stream S-wins.** SSE heartbeat + backpressure + try/catch (daemon-08); idempotent terminal events (daemon-09); single `liveJobs` liveness guard to close the post-crash SSE wedge (daemon-04 path B). | Hardens the daemon SSE fan-out and the resume-wedge. | S | [08-daemon.md](./08-daemon.md) |
| QW-10 | **Separation hygiene.** Add the `@codesurf/relay` tsconfig + Vite alias and swap the 11 deep `../../../packages/codesurf-relay/src` imports in `env.d.ts` (soc-07). | Pure hygiene, removes fragile deep-internal imports. | S | [07-separation.md](./07-separation.md) |

### Tier 2 — Structural bets (M/L)

| # | What | Why | Effort | Read |
|---|------|-----|:-:|------|
| SB-1 | **Consent-gate power extensions.** Pass `{defaultEnabled:false}` to `scanWorkspace`; never auto-`require()` a power-tier extension found in a workspace dir; require explicit per-extension enablement (mirror the catalog flow) with a trust prompt naming the path. | Closes the **RCE-on-open** critical — the single highest-priority structural fix. | M | [risk-01](./10-holes.md) |
| SB-2 | **Decompose `chat.ts` (C6).** Extract the pure prompt-convention block and the checkpoint-safety helpers into `src/main/chat/` modules with no Electron imports; rewrite the convention test to import the real module instead of scraping source. | Unblocks unit testing of the local-execution path and shrinks a 4k-LOC god-file. | M | [07-separation.md](./07-separation.md) (soc-02), [05-testing.md](./05-testing.md) (test-08) |
| SB-3 | **Memoize the canvas (perf-01).** Introduce a memoized `<CanvasTile>` (compared on all props except `tx`/`ty`) + `React.memo(TileChrome)` so pan/zoom is O(1) React work instead of O(tiles) reconciliation. | The headline performance fix; pan currently re-renders every tile. | L | [03-performance.md](./03-performance.md) |
| SB-4 | **Daemon job lifecycle.** Add a concurrency limit / backpressure on job fan-out (daemon-01); cancel in-flight jobs and kill their CLI/SDK children on shutdown/SIGTERM (C3 / daemon-02 / rel-04); make jobs cancellable from the UI (daemon-03). | Closes shutdown orphaning, runaway fan-out, and stuck-`running` metadata. | M | [08-daemon.md](./08-daemon.md) |
| SB-5 | **Bound daemon artifact growth.** Cap checkpoint snapshot bytes (daemon-06), debounce `appendEvent`'s double full-file write (daemon-07), and add retention for job metadata/timeline/checkpoints (daemon-05). | Disk and write-amplification grow unbounded per job today. | M | [08-daemon.md](./08-daemon.md) |
| SB-6 | **Unify the discovery geometry engine (C1).** Make `App.tsx` import `discovery-graph-impl.ts` for both the `<10` and `>=10` tile paths; delete the now-dead `findDiscoveryConnections` (soc-01 step 1); add an equivalence test. | The two copies already compute *different* graphs across the 10-tile boundary. | M | [06-duplication.md](./06-duplication.md) (dup-02), [07-separation.md](./07-separation.md) (soc-01) |
| SB-7 | **Wire the relay test suite into CI (gap-02).** Install vitest at the root (or port the relay tests to `node:test`) and run them from `npm test` + the new CI; confirm they pass — they may have rotted while never running. | The highest-leak-risk subsystem has zero executed coverage. | M | [05-testing.md](./05-testing.md), [10-holes.md](./10-holes.md) |
| SB-8 | **Trust-boundary cleanup (security).** Confine renderer-supplied `workspacePath` to registered roots in shared path helpers (gap-06); restrict/confine `codesurf-file://` and drop its `ACAO:*` (risk-04); route generation-provider keys through the keychain (gap-03); scope Chrome cookie injection to approved domains (risk-08). | The medium-severity remainder of the missing security axis. | M | [10-holes.md](./10-holes.md) |

### Tier 3 — Packaging plan

Existing namespace conventions: **`@contex/*`** for renderer/main shared TS (e.g.
`codesurf-relay`), **`@codesurf/*`** for daemon/runtime ESM (e.g. `codesurf-dreaming`,
`codesurf-daemon`). Align extractions to these; do not invent a third namespace.

| Action | Type | What & why | Effort | Read |
|--------|------|------------|:-:|------|
| **Extract shared session-index (C5)** | New cross-runtime package | `src/main/session-sources.ts` (2393 LOC) and `packages/codesurf-daemon/bin/session-index.mjs` (1411 LOC) are line-for-line parallel. This is the one genuine new package candidate — extract the scan/parse/sample logic to a shared module both runtimes import. | M | [07-separation.md](./07-separation.md) (soc-03), [08-daemon.md](./08-daemon.md) (daemon-10) |
| **Collapse dreaming into existing `@codesurf/dreaming` (C2)** | De-dup, **not** new extraction | `packages/codesurf-dreaming/src/index.mjs` and `packages/codesurf-daemon/vendor/dreaming.mjs` are byte-identical; the daemon imports only the vendor copy and the package is dead. Make the daemon import the named package, delete the vendor copy, fix the electrobun build to ship one. | S–M | [06-duplication.md](./06-duplication.md) (dup-01), [09-selflearning.md](./09-selflearning.md) (sl-06) |
| **Extract `prompt-conventions` + checkpoint helpers** | Pure module, **for testability, not npm** | From `chat.ts` (see SB-2). Keep in `src/main/chat/`; the goal is importability/testability, not a published package. | M | [07-separation.md](./07-separation.md) (soc-02) |
| **Extract discovery-geometry** | Pure module, **for testability** | The shared geometry pipeline behind C1 (SB-6). A pure `discovery-graph` module both call sites import; not a package. | M | [06-duplication.md](./06-duplication.md), [07-separation.md](./07-separation.md) |
| **`@codesurf/relay` alias** | Hygiene | Replace deep `../../../packages/codesurf-relay/src` imports (soc-07, also QW-10). | S | [07-separation.md](./07-separation.md) |

**Do NOT package these** (the separation section evaluated and rejected extraction —
honor those verdicts):

- **`agent-adapter-registry` (soc-04)** — well-bounded but has zero production consumers;
  wire it in or delete it, don't package it.
- **`event-bus` + `peer-state` (soc-05)** — clean single-process modules; keep in main.
- **Theme / color engine (soc-06)** — renderer-only, single-consumer. Extract a pure
  `colorMath` for *testability*, but it is not a package.

---

## 3. Cross-cutting root-cause table

The six clusters are the root causes that span dimensions; row 7 is the missing security
axis (the largest cross-cutter, surfaced only by the meta-pass). The clusters name the cause;
the **primary fix** column is the synthesized remedy.

| ID | Root cause | Dimensions affected | Primary fix |
|----|-----------|---------------------|-------------|
| **C1** | Discovery-graph geometry engine reimplemented inline in `App.tsx` (`<10` tiles) and in `discovery-graph-impl.ts` (worker, `>=10`); the two have drifted and compute different graphs. | duplication, separation, testing | Make `App.tsx` import the worker impl for both paths; delete the inline copy; add an equivalence test. (SB-6) |
| **C2** | Dreaming engine shipped as byte-identical copies in `@codesurf/dreaming` (dead) and `codesurf-daemon/vendor/`; daemon imports only the vendor copy. | duplication, self-learning | Daemon imports the named package; delete the vendor copy; build ships one. (Tier-3) |
| **C3** | Daemon shutdown/SIGTERM closes the server and removes the pid file but never cancels live jobs in `liveJobs`; spawned CLI/SDK children reparent to init and keep running and billing. | daemon, reliability | On shutdown, iterate `liveJobs`, cancel turns, and kill child PIDs before exit. (SB-4) |
| **C4** | Weak `atomicWriteJson` (`.${pid}.${Date.now()}.tmp`) reimplemented 5×; the daemon `.mjs` copies omit the UUID suffix, so same-ms same-process writes collide and rename non-atomically. | duplication, reliability | One shared hardened helper with a `randomUUID` temp suffix; replace all copies. (Tier-3 / [06-duplication.md](./06-duplication.md)) |
| **C5** | External-session indexer duplicated near-verbatim in `session-sources.ts` (TS/main) and `session-index.mjs` (daemon); a parse fix in one runtime never reaches the other. | separation, daemon | Extract a shared session-index package both runtimes import. (Tier-3) |
| **C6** | `chat.ts` (4k+ LOC) fuses Electron IO (`ipcMain`/`BrowserWindow`/`child_process`/`http`/`fs`) with pure prompt/checkpoint logic, so the pure logic can't be imported by a test. | separation, testing | Extract pure modules with no Electron imports; rewrite tests to import them. (SB-2) |
| **C7** | **No security/trust-boundary axis was ever defined.** Code-execution surfaces, the custom privileged protocol, secret-at-rest storage, the local HTTP servers, and renderer→main path trust were never evaluated — the home of both criticals and most high/medium risks. | (all — orthogonal to the 9 dimensions) | Run a dedicated security pass; start with SB-1, QW-1/2/4/5, SB-8. ([10-holes.md](./10-holes.md)) |

---

## 4. Coverage statement

**Dimensions.** Nine axes were named (refactor, memory, performance, reliability, testing,
duplication, separation, daemon, self-learning); all nine have section files
([`01-refactor.md`](./01-refactor.md) through `09`). Refactor also cross-links into
**duplication** ([06](./06-duplication.md)) and **separation** ([07](./07-separation.md))
where root causes overlap. There is **no security dimension** among the nine; that gap is the
subject of [10-holes.md](./10-holes.md). Applied fixes are tracked in [FIXES.md](./FIXES.md).

**Breadth.** Of ~306 files / ~107K LOC, the dimension audit cited roughly **66 files**;
~**250 files / ~52K LOC went unread**. Largest genuinely-uncited source files (never opened
by the dimension audit): `SettingsPanel.tsx` (2306), `ai-elements/prompt-input.tsx` (1464),
`chat/ToolBlockView.tsx` (1274), `FileExplorerTile.tsx` (1246), `KanbanCard.tsx` (1017),
`KanbanTile.tsx` (982), `PanelLayout.tsx` (976), `codesurf-relay/relay.ts` (755),
`collab.ts` (651), `db/job-indexer.ts` (580), `extensions/registry.ts` (549),
`extensions/protocol.ts`, `localProxy.ts` (432). The security-relevant ones were swept in the
meta-pass; the pure-UI files swept clean of `eval` / `dangerouslySetInnerHTML` /
`postMessage('*')` and remain un-audited refactor/perf candidates.

**Security pass — audited vs not.** The meta-pass [risk critic](./10-holes.md) audited in
depth: MCP server auth/binding/CORS/`inject`, secrets storage + IPC, Chrome-sync cookie/
keychain decryption, the `file-protocol` and `codesurf-ext://` handlers, the extension
permission/activation model, the terminal spawn allowlist, git arg-injection, DB migration
idempotency (verified solid), and path-traversal guards in `collab.ts` / `fs.ts` (verified
solid). **Not deeply audited** (declared residual scope): the `codesurf-daemon` HTTP router
(`codesurfd.mjs`, 62 inline routes — same no-auth question as the MCP server), the electrobun
dual build path, IPC input validation across the remaining ~28 `ipc/` handlers, migration
content `002`–`005`, and `child_process` usage in `provider-executor.ts` /
`session-title-generation.ts` (`execFileSync` with agent-controlled args). Vendored/generated
files (`assets/cluso/cluso-embed.js`, the committed root `index.js` bundle) are out of scope
for line audit but flagged for provenance in [10-holes.md](./10-holes.md).

---

## 5. Section index

| # | Section | Focus |
|---|---------|-------|
| 01 | [Refactoring & God-Files](./01-refactor.md) | Decomposition maps for App.tsx, ChatTile.tsx, chat.ts and other oversized units |
| 02 | [Memory Usage](./02-memory.md) | Per-tile teardown leaks, unbounded persisted maps, watcher/webview retention |
| 03 | [Performance](./03-performance.md) | Canvas render path + session/thread indexing hot zones |
| 04 | [Reliability & Error Handling](./04-reliability.md) | SDK-abort billing leak, child/PTY cleanup, shutdown gaps |
| 05 | [Test Coverage & Quality](./05-testing.md) | Untested streaming state machines, silent duplication, loose matchers |
| 06 | [Duplication & Dead Code](./06-duplication.md) | Byte-identical dreaming copy, discovery helpers, FS/JSON helpers |
| 07 | [Separation of Concerns & Package Extraction](./07-separation.md) | God-file decomposition, session-index extraction, package verdicts |
| 08 | [Daemon Process & Agent Loop](./08-daemon.md) | Job fan-out, shutdown orphaning, SSE wedge, artifact growth |
| 09 | [Self-Learning & Auto-Skill Generation](./09-selflearning.md) | Dreaming consolidation, no auto-skill generation, signal gaps |
| 10 | [Holes — Coverage Gaps & New Risks](./10-holes.md) | Missing security axis; the two criticals + supply-chain/build hygiene |
| — | [FIXES.md](./FIXES.md) | Changelog of applied fixes + deliberately-staged items |

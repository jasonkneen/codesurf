# CodeSurf — Backlog Remediation Plan

> **Archived review backlog.** This document preserves the 2026-06/07 planning
> snapshot and its original line references. Current remediation status lives in
> [`plans/2026-07-31-full-review-remediation.md`](../plans/2026-07-31-full-review-remediation.md).
> Items here may already be fixed; do not treat this file as the active queue.

The current integration supersedes the historical provider-streaming, daemon,
context, peer, attachment, local-proxy, and Electrobun lifecycle items below.
It adds bounded daemon SSE decoding; strict host-validated provider/peer
authority with untrusted bounded observations; provenance-gated recent-edit
reads; authoritative clear and preparation leases; local-proxy resource and
terminal fencing; attested attachment capabilities; and process/session-safe
Electrobun turns. Final exact-tip clean-checkout verification is still pending,
so implementation status and proof status are intentionally reported
separately in the current remediation plan.

Executable plan for the items left after the Critical/High/Medium remediation (see `docs/REMEDIATION_PLAN.md`). Findings reference `docs/CODE_REVIEW.md`. Each item is scoped to be dispatchable as a single focused agent task.

Phases are ordered by value × risk. Phase 1 is the one deferred Critical (the plugin broker); Phases 2–3 are remaining Mediums; Phase 4 is the Low hardening sweep. Items within a phase are grouped by **disjoint file sets** so they can be parallelized safely.

Effort key: **S** ≤ ~30 min · **M** ~1–3 h · **L** ~half-day+ · **XL** multi-day design+build.

---

## Phase 1 — Plugin execution broker (deferred CR-3) · XL

**Goal:** Replace raw `require()` of power/node extensions into the main process with a brokered, isolated execution tier, as specified in `docs/plugins/00-architecture.md` §6/§14. This is the only Critical that is contained-and-documented rather than structurally fixed.

**Current state (verified):** `src/main/extensions/loader.ts` `loadPowerExtension` does `require(entryPath)` + `mod.activate(ctx)` directly in main. `ctx` (`extensions/context.ts`) hands the extension the full capability surface. Activation is gated (default-OFF for workspace/catalog) but runtime confinement is zero. Architecture doc already names the target: a `worker`/utilityProcess tier where "node execution flows through the broker."

**Design (incremental, 4 sub-phases — do NOT attempt in one PR):**

1. **1a · Broker IPC contract (M).** Define the message protocol between main (broker host) and a child `utilityProcess` running extension code: `activate`, `deactivate`, capability-call request/response, event emit. Reuse the existing OWL `JsonRpcPeer` framing (`src/main/owl/runtime.ts`) — it already does length-or-newline-delimited JSON-RPC with error envelopes and partial-buffer handling. Write the contract types in a new `src/main/extensions/broker/protocol.ts`. No behavior change yet.

2. **1b · Capability proxy (L).** In the child process, `ctx` becomes a *proxy* whose every method marshals a capability call back to main over the broker. Main validates each call against the extension's **granted** capabilities (the `getCapabilityGate(extId)` data that today only gates the iframe bridge) before executing. This is where least-privilege actually lands: an extension granted only `chat` cannot touch `fs`/`shell`. Enforce in MAIN, never in the child.

3. **1c · utilityProcess host (L).** Spawn extension code via Electron `utilityProcess.fork` (Node context, but a separate OS process — crash-isolated, killable, no direct access to main's globals/secrets). Port `loadPowerExtension` to send `activate` over the broker instead of `require()`. Keep the hot-reload (`delete require.cache`) behavior inside the child. Handle child crash → emit a "extension crashed" event, don't take down main.

4. **1d · Migrate + retire the special-case (M).** Move the bundled `codesurf-relay-suite` (the hardcoded `id === 'codesurf-relay-suite'` relay bridge mentioned in §6) onto the broker as the first real consumer. Once green, flip the default so new power extensions run brokered; leave a documented escape hatch for trusted bundled extensions if needed during transition.

**Risk:** High — touches every power extension's runtime. Mitigate: keep the raw-`require` path behind a feature flag until 1d is proven; migrate one extension at a time; add an integration test mirroring `test/hosts/owl-host-integration.test.mjs` (lifecycle, capability-deny, crash-recovery, PNG/asset round-trip).

**Acceptance:** A power extension granted only `chat` is provably unable to read `~/.ssh` (test asserts the `fs` capability call is rejected in main); killing the child process does not crash main; `codesurf-relay-suite` works through the broker.

---

## Phase 2 — Remaining Medium correctness/resilience

Disjoint file sets → 3 parallel agents.

### 2a · OWL runtime (M) — `src/main/owl/runtime.ts`
- **Multi-char text input lost** (`runtime.ts:91`): `{type:'char', keyCode: event.text}` sends a single character per Electron `sendInputEvent`, so multi-char agent-driven text loses everything after char 1. **Fix:** in `translateOwlInputToElectron`, when the OWL event is `text` with a multi-char string, emit one `char` event per code point (return an array / loop at the call site `runtime.ts:310`).
- **Supervisor silent state-loss on crash** (`StdioOwlHostSupervisor` `runtime.ts:369-409`): on child `exit`/`error` both `child`/`peer` null and the next `call()` transparently respawns, losing all session/profile/webview state with no caller signal. **Fix:** track a single in-flight `starting` promise (no concurrent double-start); on unexpected exit, surface an explicit `host restarted, state lost` error to the next caller instead of silently continuing; add minimal restart backoff.
- **Webview URL scheme allowlist** (`runtime.ts:281-293`): `webview.create`/`navigate` load any string (`file://`, `chrome://`) into an offscreen window driven by `owl:*` IPC. **Fix:** allowlist `http`/`https`/`about` (mirror chrome-sync domain-allowlist); reject others. Sandbox/contextIsolation/`setWindowOpenHandler(deny)` are already correct.
- **Add a JsonRpcPeer unit test (S):** framing/buffering/partial-line/error-envelope — the most reusable, logic-dense, currently-untested piece (it'll also underpin Phase 1).

### 2b · Provider streaming bounds (M) — `src/main/chat/providers/codex.ts`, `claude.ts`, `src/main/ipc/stream.ts`
- **Codex stdout backpressure** (`codex.ts:510-527`): `pendingStdout`/`stdoutChain` grow unbounded while the async chain awaits daemon checkpoints + per-file `git diff`. **Fix:** `proc.stdout.pause()` when the chain backlog exceeds a threshold, resume after flush.
- **Unbounded stderr buffers** (`codex.ts:529-530`, `claude.ts:689`): cap to last ~64 KB.
- **Codex `turn.failed`/`error` events dropped** (`codex.ts:400-447`): only `thread.started`/`item.*` handled; a failed turn can show a clean empty `done`. **Fix:** handle `turn.failed`/`error` → `sendStream({type:'error'})`; set an `aborted` flag after checkpoint-failure (`:436-440`) that short-circuits the rest of the chain so buffered text doesn't stream after the error chip.
- **Claude abortController never aborted** (`claude.ts:501`): keep it reachable from `chat:stop` (a `cardAbortControllers` map) and call `.abort()` alongside `q.close()`.

### 2c · session-sources correctness + structure (M→L) — `src/main/session-sources.ts`
- **Duplicate message ids** (`session-sources.ts:1847, 2340`): `Math.max(0, lines.length * -1)` is always `0`, so head and tail samples both emit `claude-0, claude-1, …` — duplicate React keys + unstable paging fingerprints. **Fix:** give tail a disjoint namespace (`claude-tail-${i}`), matching the codex parser's `10_000`-offset approach (`:2031`).
- **Self-defeating large-codex fast path** (`:2022-2027` calling `findLatestCodexPlanSnapshotMessage` `:1979`): the `>6 MB` branch that exists to avoid reading the whole file then streams every line through `JSON.parse`. **Fix:** scan only the tail sample, or defer the full scan to the daemon.
- **Session-id / message-id confusion** (`:1918`): a `msg_…` id can be returned as the resumable session id when `entry.sessionId` is null. **Fix:** only accept ids matching the session-id shape.
- **Structure (separate PR, L):** the file is 2370 LOC of 7 provider listers + parsers + 3 caches. Split per-source mirroring `chat/providers/`. Also (Low) move the synchronous `better-sqlite3` opens during listing (`:1405-1525`) off the main thread into the daemon indexer.

---

## Phase 3 — Remaining Medium perf/UX

Disjoint → 2 parallel agents.

### 3a · Renderer list/render perf (M) — Kanban, FileExplorer, Sidebar
- **KanbanCard recomputes per render** (`KanbanCard.tsx:172-216`): `cardPalette`, `toolSuggestions`, `cardSuggestions`, `unresolvedStartAfter` rebuilt on any parent re-render for every card. **Fix:** `useMemo` them + `React.memo` the component.
- **FileExplorer full recursive reload per watch tick** (`FileExplorerTile.tsx:766-816`): `reloadAll` re-fetches the entire expanded tree on every fs-watch event. **Fix:** debounce 200–300 ms and/or reload only the changed subtree.
- **Sidebar multi-effect reconciliation** (`Sidebar.tsx:984-1112`): six effects keyed on `sessions` each fan out into multiple setStates + dependent memos over the full array. **Fix:** consolidate watermark/promotion reconciliation into one reducer effect; confirm the session row component is `React.memo` (the `useCallback` renderer alone doesn't memoize rows).

### 3b · Decomposition (L) — oversized components
Pure-extraction refactors, lowest risk first:
- **BrowserTile.tsx** → move the Cluso injection string-builders (`:358-693`) to `browser/clusoInjection.ts` and the webview adapter factories (`:109-312`) to `browser/webviewAdapters.ts` (~600 LOC out, zero behavior change).
- **Sidebar.tsx** → extract `useSidebarSessions` + `useSidebarSessionSelection` hooks (the loading/watermark/promotion/visibility logic ~924-1465).
- **SettingsPanel.tsx** → pull Chrome-Sync block, extensions list, and each settings domain into `settings/` section components; panel becomes a router.

---

## Phase 4 — Daemon + Low hardening sweep

### 4a · Daemon robustness (M) — `packages/codesurf-daemon/bin/*`
- **Process-group kill** (`chat-jobs.mjs` shutdown ~1883, spawns ~1259/1480/1549): `proc.kill()` signals only the direct child; codex/opencode/hermes spawn their own descendants that survive. **Fix:** `spawn(..., { detached:true })` + `process.kill(-pid, 'SIGTERM')` for the group; gate SIGKILL on actual exit, not a flat 500 ms.
- **Duplicate-daemon lock file** (`codesurfd.mjs` `reuseExistingDaemonIfHealthy` ~2784): TOCTOU between health check and `listen`. **Fix:** `O_EXCL` lock file in `~/.codesurf/daemon/`.
- **Uncapped command-output length in timeline** (`chat-jobs.mjs` the new command-block path ~1339): clamp `output` to a max length before writing to the JSONL.
- **lastSequence desync after crash** (`chat-jobs.mjs:824` vs metadata flush): derive `baseSeq` for synthetic terminal events from the max sequence actually present in the timeline file, not from possibly-stale `metadata.lastSequence`.

### 4b · Low security/hygiene (S each — batch into one agent) 
- **MCP server fail-closed** (`mcp-server.ts:406-420`): require the bearer token on every non-OPTIONS method rather than enumerating sensitive routes, to keep the CORS-safety invariant robust to future routes.
- **SSE client Set cleanup** (`mcp-server.ts:525-536`): `if (set.size === 0) sseClients.delete(cardId)` on disconnect.
- **event-bus wildcard sub leak** (`event-bus.ts:132-147`): `dropChannelsMatching` skips wildcard subs under the dropped prefix.
- **chrome temp-DB perms + sweep** (`chrome-sync/cookies.ts:99-105`, `history.ts:33-37`): create temp copies `0o600`; sweep `chrome-sync-temp` on startup.
- **keychain password cache lifetime** (`chrome-sync/keychain.ts:3,24`): call the existing `clearCachedPassword()` after each sync (currently never called).
- **`peer_set_state` status `as any`** (`mcp/tools/context.ts:198`): validate against the status union instead of casting.
- **NoteTile innerHTML hardening** (`NoteTile.tsx:23-44,489-497`): NoteTile content is agent-writable over the bus; route its markdown through the same protocol allowlist used for chat, or render to DOM nodes instead of `innerHTML`.
- **`canvas_pan_to` coord math** (`App.tsx:882-884`): `tx = screenCenter - x*zoom`, not raw assignment — agents calling the tool currently get incoherent pans.
- **Unbounded `nextZIndex` + per-click persist** (`App.tsx:925-934`): normalize z-indices on save; avoid scheduling a disk write on every `onMouseDownCapture`.
- **Temp-file litter sweep** (`storage/jsonArtifacts.ts:80-85`): startup sweep of orphaned `*.tmp`; optional `fsync` before rename.
- **collab watcher per-sender cleanup** (`ipc/collab.ts:281-362`): add a `sender.destroyed` teardown so a window closing without `collab:unwatch` doesn't leak the chokidar watcher until quit (terminal/fs/bus already do this).
- **`relay:spawnAgent`/`sendDirectMessage` shape validation** (`ipc/relay.ts:77,101`): assert object shape at the IPC boundary before handing `any` to the relay service.
- **`say` argument injection** (`ipc/tts.ts:170-176`): reject `voice` starting with `-`; pass `text` after `--`.

---

## Suggested execution order

1. **Phase 4b** first as a quick win (one agent, ~all S items, high signal-to-effort).
2. **Phase 2** (correctness — OWL input loss, dropped error events, duplicate ids are real user-facing bugs).
3. **Phase 3a** (perf) + **Phase 4a** (daemon) in parallel.
4. **Phase 1** (broker) as a dedicated milestone with its own branch and the 1a→1d sub-phasing — do not interleave with the above.
5. **Phase 3b** decomposition opportunistically (low risk, improves everything downstream).

Every item: verify with `tsc --noEmit` (no new errors vs the 10-error baseline) / `node --check` for `.mjs`, and where a test harness exists (OWL, broker) add a regression test.

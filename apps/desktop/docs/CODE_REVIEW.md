# CodeSurf — Full Code Review

Date: 2026-06-09. Branch: `main` (HEAD `ca5fec0`). Read-only review across 8 subsystems by parallel reviewers; headline findings spot-verified against source.

Scope: Electron main core + security, IPC layer, chat/provider subsystem, canvas engine + renderer perf, plugin/extension platform, daemon + relay packages, renderer UI components, data/sync/storage.

---

## Executive summary

The architecture is sound and the security *baseline* is better than most Electron apps: `contextIsolation:true` / `nodeIntegration:false` on the main window, guest webviews forced to `sandbox:true` with the preload stripped, secrets via `safeStorage`/keychain, atomic JSON writes in the canonical storage helpers, parameterized SQL everywhere, a real SSRF guard, and DNS-rebinding defenses on the MCP server. The verified-correct list at the bottom is long.

The problems cluster in three places:

1. **Authorization granularity, not authentication.** The MCP server, the daemon, and the plugin bridge each authenticate with a single ambient token, but that one token then gates capabilities as powerful as terminal command injection, arbitrary file read, and agent spawning in bypass-sandbox mode. The token files are also written world-readable in two of three cases.
2. **Untrusted input crossing trust boundaries without the sanitizer that siblings already use.** Several MCP/IPC handlers build filesystem paths from caller-supplied IDs (`tile_id`, `profileDir`) while the equivalent code one file over correctly calls `assertSafePathSegment`. These are real, exploitable path traversals.
3. **The plugin platform's isolation is largely aspirational.** Cross-plugin iframe isolation is broken (shared origin), `power`-tier plugins `require()` straight into the main process with no sandbox, and the capability gate is enforced in the renderer (the wrong process) with a startup race.

Plus two **silent functional regressions** worth fixing immediately because they fail invisibly: Codex local runs never resume their session (multi-turn context lost), and the job indexer throws on every job *update* (`undefined` bound to a non-null SQLite column), so the dashboard job index goes stale after first insert.

Counts: **6 Critical, 12 High, ~20 Medium, ~18 Low.**

---

## Critical

**CR-1 — Chrome cookie sync injects the ENTIRE cookie jar by default, and any renderer can target any partition.**
`src/main/chrome-sync/cookies.ts:80-86`, `src/main/ipc/chromeSync.ts:26-33`
`chromeSyncApprovedDomains` defaults to `[]` (`types.ts:702`); with an empty list `syncCookiesToPartition` copies *every* decrypted cookie for *every* site into a browser-tile partition (verified — the empty-list branch only `console.warn`s and proceeds to inject all). The IPC handler takes `profileDir` and `partition` as untrusted renderer args with no validation that the partition belongs to a real tile. Impact: full session-cookie exfiltration of the user's Chrome profile (banking, email, cloud consoles) into a partition that agent-controlled URLs then load. **Fix:** flip the default to deny — an empty allowlist injects nothing; require the approval UI; validate `partition` against live browser-tile partitions.

**CR-2 — Cross-plugin iframe isolation is broken; all custom-HTML extensions share one origin.**
`src/renderer/src/components/ExtensionTile.tsx:792`, `src/main/extensions/protocol.ts:40-51,74-79`
The iframe is `sandbox="allow-scripts allow-same-origin allow-modals"` and `contex-ext` is a single standard origin, so plugin A can `fetch('codesurf-ext://extension/<extB-id>/...')` and read every other enabled plugin's on-disk source/assets (templates, embedded tokens, prompts). The sandbox-proxy code explicitly warns "NEVER add allow-same-origin to the inner frame" — the primary path does exactly that. **Fix:** drop `allow-same-origin` (the bridge uses postMessage, not same-origin DOM), or serve each extension from a per-extension origin and scope resource-auth to the requesting extId.

**CR-3 — `power`-tier extensions are unsandboxed `require()` into the main process.**
`src/main/extensions/loader.ts:21-29`
`require(entryPath)` + `mod.activate(ctx)` runs with full Node/fs/`child_process`/network. The capability system governs only the iframe bridge; it has zero effect here. Any enabled power plugin can read `~/.ssh`, spawn processes, and reach every other plugin's state. The architecture doc says `node` execution "should flow through the broker rather than raw require() into main" — unimplemented. **Fix:** move to a utilityProcess/worker with brokered capabilities; until then, document `power` = full-trust / equivalent to installing native software, and keep the untrusted-scope default-off activation gate.

**CR-4 — MCP `reload_objective` / `get_context` path traversal → arbitrary file/dir read.**
`src/main/mcp-server.ts:291-301, 315-335` (verified: `tileId` from args used raw in `join(ws.path, '.codesurf', tileId, ...)`; no `assertMcpSafeId` anywhere in this file, unlike `mcp/tools/context.ts`)
`tile_id: "../../../../etc"` escapes the tile dir; `get_context` then `readdir`s the target and returns the concatenated contents of every file in it. Any holder of the MCP token (every local agent) reads arbitrary files through the "kanban" server. **Fix:** run `tile_id` through `assertSafePathSegment` in `handleLocalTool` before building any path — the sibling context tools already do.

**CR-5 — Job metadata writes are non-atomic; a crash mid-write corrupts the record and leaks it forever.**
`packages/codesurf-daemon/bin/chat-jobs.mjs:788` (`writeJobMetadata` uses plain `fs.writeFile`, unlike `atomicWriteJson` used everywhere else)
A `SIGKILL` during this write truncates `{jobId}.json`; `readDaemonJobRecords` and `sweepJobRetention` both `JSON.parse`-in-try and silently `continue` on failure, so the corrupted record is invisible to the dashboard *and* un-prunable — the file and its timeline leak permanently. **Fix:** route through the existing temp-file+rename atomic write.

**CR-6 — Daemon job indexer binds `undefined` to a non-null PK; every job *update* throws and aborts the scan.**
`src/main/db/job-indexer.ts:451` (verified: `id: prev ? undefined : randomUUID()`)
`id` is `TEXT PRIMARY KEY`; better-sqlite3 throws `TypeError` on an `undefined` named param rather than substituting the default. So for any already-indexed job whose file changes (the `prev` branch), `.run()` throws inside the txn, the transaction aborts, and the outer catch logs `[jobs] scan failed`. Net: the job index never updates existing rows after first insert — status, completion time, error text all go stale, silently. **Fix:** bind `null` instead of `undefined` and let `ON CONFLICT` leave `id` untouched, or split insert/update statements.

---

## High

**H-1 — MCP token grants terminal command execution and is written plaintext into every workspace.** `mcp-server.ts:716-746,687`. The single bearer token is the only authz boundary for `tools/call`, and the toolset includes `terminal_send_input` (arbitrary text+Enter into a terminal tile = RCE-equivalent). `.mcp.json` lands in user project trees (0o600, gitignored — good) but in cleartext by design. **Fix:** scope tokens per workspace/tile, or gate side-effecting tools behind the permission-prompt flow.

**H-2 — Daemon auth token file is world-readable → any local user gets full RCE-equivalent control.** `codesurfd.mjs:3808` writes `~/.codesurf/daemon/pid.json` (port+token) at default 0644; the daemon can spawn agents in `--dangerously-bypass-approvals-and-sandbox` mode. Any other local user reads the file and POSTs `/chat/job/start` with `mode:"full-access"`. **Fix:** `writeFileSync(..., { mode: 0o600 })`, `mkdirSync(..., { mode: 0o700 })`, restrict `~/.codesurf` to 0700.

**H-3 — `chromeSync` `profileDir` path traversal into `copyFileSync`/`readFileSync`.** `chrome-sync/profiles.ts:39-41` + handlers in `ipc/chromeSync.ts:26-39`. `profilePath` is `join(CHROME_BASE, profileDir)` with no guard; `../../..` points the cookie/history/bookmark reader at arbitrary files. Bookmarks `JSON.parse`s and returns content = partial arbitrary-file-read. **Fix:** `assertSafePathSegment(profileDir)` or validate membership in `listProfiles()`.

**H-4 — `skills:install` extracts an arbitrary zip to an arbitrary `targetDir` (zip-slip + attacker-influenced recursive delete).** `ipc/skills.ts:147-192`. `targetDir` taken verbatim into `unzip -o -d`, `topFolder` derived from archive contents then `fs.rm(installedPath, {recursive,force})` on overwrite. **Fix:** constrain `targetDir` to the known skills dir, validate `topFolder` and reject `..` entries before extraction.

**H-5 — `display-capture` / `media` auto-granted to guest webview content.** `index.ts:365-404`. Handlers on `session.defaultSession` (which backs guest `<webview>` tiles loading arbitrary URLs) return true for `display-capture` unconditionally. A malicious page calls `getDisplayMedia()` and gets full-screen capture. **Fix:** branch on `_webContents` — only auto-grant for the trusted main renderer; deny/prompt for guests.

**H-6 — Renderer-side capability gate has a startup race and covers only 3 of the powerful namespaces.** `ExtensionTile.tsx:213-232`, `bridge.ts:22`. Gate is fetched async; null = ungated, so a malicious iframe can fire `chat.send`/`relay.spawnAgent`/`canvas.createTile` before it resolves. `bus.*`, `store.*`, `settings.*`, `context.*`, `ext.invoke` are ungated for every plugin. Enforcement lives in the renderer (where the iframe's host controls the gate value over IPC) instead of in main. **Fix:** enforce authoritatively in the main-process IPC handlers; widen the gated set.

**H-7 — Plugin zip/vsix install: archive path-traversal + symlink escape, no manifest validation.** `ipc/extensions.ts:44-53`. `unzip -o` follows symlinks; the flatten loop blindly moves whatever lands under `extension/`; install dir keyed on archive *filename*, not validated manifest id — a crafted package can overwrite another plugin's `main.js` (which then auto-runs in main). **Fix:** allowlisting unzip that rejects `..`/absolute/symlink entries; validate manifest before commit; key on validated `id`.

**H-8 — Codex local runs never resume their session (multi-turn context silently lost).** `chat/providers/codex.ts:342-375` sends only the last user message and never passes `resume`, despite capturing and persisting the thread id. The daemon path does it correctly (`chat-jobs.mjs:1130`). Every runtime-backed Codex turn after the first is contextless. **Fix:** spawn `codex exec resume <threadId> --json` when a session id exists.

**H-9 — Foreground-replacement race in CLI providers corrupts `activeProcesses`, leaks a zombie, injects stale `done`/`error`.** `ipc/chat.ts:856-859` + `codex.ts:532-555` (same pattern in `hermes.ts`, `openclaw.ts`). The old proc's `close` handler runs `activeProcesses.delete(cardId)` unconditionally, deleting the *new* turn's entry → can't kill the new codex proc (keeps billing), and emits `done`/`error` into the new turn. Claude is protected; the CLI providers are not. **Fix:** identity-guard all terminal handlers (`if (activeProcesses.get(cardId) === proc)`) + a "superseded" flag.

**H-10 — OpenCode server crash permanently poisons `ensureRunning`.** `opencode.ts:83-96,136-143`. On server `exit`, `server`/`port` null but `startPromise` doesn't, so `ensureRunning` forever returns the stale promise pointing at the dead port — all OpenCode chat fails until app restart. **Fix:** `this.startPromise = null` in the exit handler.

**H-11 — Undo: drag/resize/group-move never reach the undo stack.** `useCanvasDragSync.ts:308-356`, `App.tsx:287-288`. `saveCanvas` diffs `tilesRef.current` (already mutated to the final position per RAF) against the passed list → empty diff → discarded. Cmd+Z after a drag undoes the *previous* operation. **Fix:** capture a pre-drag snapshot at drag start and diff from that.

**H-12 — Undo recording is permanently disabled after the first undo (shared `saveTimer` collision).** `useCanvasEngine.ts:563-591,366-386`. `applyHistoryEntry` schedules the only `skipHistory=false` reset on `saveTimer`, but the `setTiles` it issues triggers the auto-save effect, which `clearTimeout(saveTimer.current)` first — killing the reset. After one Cmd+Z, every `saveCanvas` skips history for the rest of the session. **Fix:** reset `skipHistory` synchronously; don't share one timer ref between undo-save and the normal debounce.

---

## Medium (selected — full list in per-subsystem notes)

- **TileChrome memo ignores most props it renders** (`TileChrome.tsx:1008-1022`, verified): comparator checks only selection/interaction + 7 geometry/id fields, ignoring `label`, `hideTitlebar`, `borderRadius`, `discoveryConnected`, `connectedPeers`, `busUnreadCount`, `children`. Repro: "Hide Controls" / rename does nothing until a click bumps `zIndex`. Currently masks the M-class memo defeat below, so fix them together.
- **Tile memoization defeated every pan/zoom frame** (`useCanvasEngine.ts:430-434`): `screenToWorld`/`onConnectionMouseDown`/`handleTileContextMenu` get new identities per viewport change → every tile re-renders. Only survives because the broken TileChrome comparator blocks the subtree. Fix `screenToWorld` to read `viewportRef.current`.
- **Full App re-render on every canvas mousemove feeding dead state** (`AppCanvasSurface.tsx:171-177`): `setCanvasPointerWorld` fires per pointer move; the value has no consumer. Delete it or move to a ref.
- **Workspace switch loses ≤500ms of edits and can cross-contaminate canvases** (`useCanvasEngine.ts:366-386` + `useAppWorkspaceOrchestration.ts:141-177`): `setWorkspace(B)` before `canvas.load(B)` resolves → auto-save writes A's tiles into B's id. Flush (not cancel) the pending save and gate auto-save on a "loaded for this id" flag. Related: undo stacks survive workspace switches and replay cross-workspace (`useCanvasEngine.ts:305-306`).
- **BrowserTile webview remounts on every resize** (`BrowserTile.tsx:1203,1508`): `recordBrowserEvidence` depends transitively on `[height,width]`, so a resize drag tears down/reattaches the guest WebContents and re-injects scripts each step. Ref the viewport size.
- **Chat markdown renders AI-controlled hrefs with all protocols allowed** (`streamdown-utils.tsx:645-663`): Streamdown defaults to `allowedProtocols:["*"]`; only a capture-phase click interceptor prevents `javascript:`/`file:` execution in the privileged renderer. Add `allowedProtocols={['http','https','mailto']}`.
- **Webview popups/`target=_blank` silently broken** (`BrowserTile.tsx:1327-1333`): `new-window` DOM event was removed in Electron 22 (project on 41); handler never fires. Use `setWindowOpenHandler` in main.
- **Privacy: local absolute workspace path leaks to cloud for no-remote repos** (`privacy/provider-context-policy.ts:49-51`): `|| !context.gitRemoteUrl` overrides the `includeWorkspaceDir:false` redaction exactly when it should apply.
- **MCP peer-bridge note read/write uses unvalidated `tile_id` in a path** (`mcp/tools/peer-bridge.ts`): same missing `assertSafeWorkspaceArtifactId` as CR-4.
- **Daemon global crash handler too broad** (`codesurfd.mjs:3878-3885`): any `unhandledRejection` calls `shutdown()` + `exit(1)`, killing every concurrent job across all hosts. `void runJob(...)` preamble throws escape here. Wrap `runJob` to emit `error`+`done`; log-and-continue on unhandledRejection.
- **Dreaming "read-only" depends on an unverified SDK ordering under `bypassPermissions`** (`vendor/dreaming.mjs:337-346`): relies on `canUseTool` firing under bypass mode, which the SDK docs contradict. Use `permissionMode:'plan'` or `tools:[]` to structurally prevent tool use.
- **OpenCode 5-min hard timeout + non-aborting loop exit leaks SSE connections**; **rapid resend runs two prompts on one OpenCode session** (`opencode.ts:433-443`, `chat.ts:848-868`).
- **Pi runtime leaks a session + subscription per turn** (`pi-runtime.ts:564-584`).
- **`fs:*` handlers swallow errors → silent data loss** (`ipc/fs.ts:231,252`): `readFile` returns `''` on EACCES, so a load-then-save round trip can zero a real file. Also `fs:writeFile` is non-atomic (`fs.ts:264`).
- **localProxy: unauthenticated loopback relay with wildcard CORS** (`ipc/localProxy.ts:151,362`).
- **OWL: multi-char text input only delivers first char** (`owl/runtime.ts:92`); **supervisor silently respawns on crash losing all state** (`runtime.ts:374-409`).
- **`Math.max(0, lines.length * -1)` always 0 → duplicate message ids in transcript import** (`session-sources.ts:1847,2340`).
- **enable() can double-register MCP tools / leak prior activation** (`extensions/registry.ts:683`).

---

## Low (themes)

Codex stdout has no backpressure (unbounded buffer growth); stderr buffers uncapped across providers; `turn.failed`/`error` Codex events dropped; head/tail transcript scan still reads whole file on the >6MB "fast path"; synchronous better-sqlite3 opens on the main thread during session listing; `canvas_pan_to` coordinate math wrong; unbounded `nextZIndex` persists per click; KanbanCard/FileExplorer missing memoization + watch debounce; keychain password cached for process lifetime; chrome temp DB copy world-readable with no startup sweep; `peer_set_state` status `as any` cast; SSE client `Set`s never deleted; event-bus wildcard subs leak on `dropChannelsMatching`. See per-subsystem agent notes for file:line.

---

## Verified-correct (do not "fix")

- Main-window Electron hardening: contextIsolation on, nodeIntegration off, guest webviews sandboxed with preload stripped + webSecurity on + allowpopups off.
- Secrets via `safeStorage`/keychain with atomic 0o600 writes; renderer can set/clear/check but never read back.
- `codesurf-file://` protocol: tested traversal + sensitive-dir denylist + deliberate CORS strip.
- MCP server: DNS-rebinding (Host-header) + body-size defenses; CORS reflection is safe *because* no credentials/cookies and token isn't a cookie (but make it fail-closed on every method to keep the invariant).
- SQL: parameter-bound everywhere; no string-concatenated queries. DB lifecycle: WAL, pre-migration backup, single-txn monotonic migrations.
- Cookie crypto params match Chromium macOS os_crypt; decrypt failure → empty, not crash.
- `urlSafety.assertSafeStreamUrl` blocks localhost/link-local/RFC1918/IPv4-mapped IPv6 (real SSRF guard). `mergeTileState` blocks `__proto__`/`constructor`/`prototype`.
- git/agents IPC: `execFile` (no shell), branch-name guarding, `--end-of-options`. fs watchers + PTY/tmux + bus subscriptions + browser BrowserViews all have correct per-sender/per-window teardown.
- Canonical storage helpers (`jsonArtifacts`, `snapshot-store`) use temp+rename atomic writes with balanced-prefix recovery. Canvas *write* side is atomic (only the *load* side lacks validation).
- The uncommitted `codex.ts` / `chat-jobs.mjs` diff (surface Codex `command` executions as tool blocks) is correct and ship-safe; only nit is uncapped command-output length in the timeline.

---

## Recommended fix order

1. **CR-1** flip chrome-sync default to deny + validate IPC inputs (also fixes H-3 surface).
2. **CR-4** + peer-bridge: add `assertSafePathSegment` to every MCP/IPC path built from a caller ID (one shared helper, ~5 call sites).
3. **CR-6** job-indexer `undefined`→`null` (one-char fix, restores the dashboard) and **CR-5** atomic `writeJobMetadata`.
4. **H-2 / H-1** token-file perms (`0o600`/`0o700`) + scope/gate MCP side-effecting tools.
5. **H-8 / H-9** Codex resume + identity-guard the provider run handles (one shared "run handle with `isCurrent()`" abstraction kills four bugs).
6. **H-12 → H-11** undo correctness pair, then the M-class memo rework (fix TileChrome comparator + `screenToWorld` identity together).
7. **Plugin platform (CR-2, CR-3, H-6, H-7)** — the largest body of work; treat as a hardening milestone before third-party authors. Until done, document `power` plugins as full-trust.

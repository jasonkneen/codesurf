# CodeSurf — Remediation Plan

> **Archived remediation snapshot.** This file records the 2026-06-09 pass.
> Current full-review disposition and verification are in
> [`plans/2026-07-31-full-review-remediation.md`](../plans/2026-07-31-full-review-remediation.md).

The current integration now includes bounded daemon SSE; provider and peer
authority enforcement; host-attested recent-edit provenance; generation-fenced
chat preparation and authoritative session clear; managed-local-proxy limits
and completion fencing; attested attachment capabilities; and Electrobun
process, session, hydration, and temporary-file lifecycle hardening. Peer
topology is host-validated, while user-role peer observations remain untrusted
and bounded. These implementation updates do not imply that the final exact
branch tip has passed its detached clean-checkout proof; that record remains
pending under Plan 015.

Tracks fixes for findings in `docs/CODE_REVIEW.md`. Status as of 2026-06-09.

## Critical — DONE

| ID | Fix | Files |
|----|-----|-------|
| CR-1 | chrome-sync default-DENY (empty allowlist injects nothing; `allowUnscoped` opt-in) + `profileDir` traversal guard (`assertSafeProfileDir`) + partition validation | `chrome-sync/cookies.ts`, `chrome-sync/profiles.ts`, `ipc/chromeSync.ts` |
| CR-2 | Per-extension origins (`codesurf-ext://<extId>`); removed wildcard CORS; scoped resource-auth to requesting ext; sandbox-proxy on dedicated `__runext_sandbox__` host | `extensions/registry.ts`, `extensions/protocol.ts`, `extensions/sandbox-proxy.ts`, `shared/mcpUiProxy.ts` |
| CR-3 | Defense-in-depth load gate (`isPowerActivationPermitted`), load-time `[Security]` warnings, fixed MCP-tool double-registration, documented trust boundary; broker deferred | `extensions/loader.ts`, `extensions/registry.ts`, `docs/plugins/00-architecture.md` |
| CR-4 | `assertSafePathSegment(tile_id)` in `reload_objective`/`get_context` | `mcp-server.ts` |
| CR-5 | Atomic `writeJobMetadata` (temp + rename) | `codesurf-daemon/bin/chat-jobs.mjs` |
| CR-6 | Always bind a valid UUID `id` (ignored on conflict) — restores job index updates | `db/job-indexer.ts` |

## High — DONE

| ID | Fix | Files |
|----|-----|-------|
| H-1 | Real permission-prompt gate on `terminal_send_input` (uses existing `requestToolPermission`) + blast-radius warning; `.mcp.json` confirmed 0o600 | `mcp/tools/peer-bridge.ts` |
| H-2 | `atomicWriteJson` writes 0o600, `ensureDir` creates 0o700 (covers pid/token file + all daemon state) | `codesurf-daemon/bin/codesurfd.mjs` |
| H-3(undo) | Clear undo/redo stacks on every canvas load/switch (`clearHistory`) | `useCanvasEngine.ts`, `useAppWorkspaceOrchestration.ts`, `App.tsx` |
| H-4 | `skills:install`: reject symlink/`..`/absolute zip entries, scope `targetDir` + `topFolder` via `resolveInside`/`assertSafePathSegment` | `ipc/skills.ts` |
| H-5 | Deny `display-capture`/`media` to guest webviews (`isTrustedAppRenderer`); main renderer unaffected | `index.ts` |
| H-7 | Plugin extraction: reject unsafe entries, extract to scoped temp, validate manifest before commit, key install dir on validated `id` | `ipc/extensions.ts` |
| H-8 | Codex `exec resume <threadId>` when a session id exists — restores multi-turn context | `chat/providers/codex.ts` |
| H-9 | Identity-guard (`isCurrent()`) on terminal handlers in codex/hermes/openclaw — no stale done/error, no zombie | `chat/providers/{codex,hermes,openclaw}.ts` |
| H-10 | Reset `startPromise=null` on OpenCode server exit | `chat/providers/opencode.ts` |
| H-11 | Pre-drag snapshot (`beforeTiles`) so drag/resize/group-move reach the undo stack | `useCanvasEngine.ts`, `useCanvasDragSync.ts` |
| H-12 | Dedicated `skipHistoryResetTimer` (persist path can't clear it) — undo no longer dies after first use | `useCanvasEngine.ts` |

## Medium — DONE (this pass)

- Per-extension memo: TileChrome comparator now compares all rendered props + `screenToWorld` reads `viewportRef` (stable identity) — landed together. (`TileChrome.tsx`, `useCanvasEngine.ts`)
- MCP-tool double-registration on enable/activate fixed. (`extensions/registry.ts`)
- OpenCode rapid-resend aborts live SSE; 5-min hard timeout → inactivity timeout. (`ipc/chat.ts`, `opencode.ts`)
- peer-bridge `tile_id` traversal guard. (`mcp/tools/peer-bridge.ts`)
- Chat markdown: `urlTransform` allowlist (http/https/mailto/relative) + `ThemedMarkdownLink` href sanitize. (`streamdown-utils.tsx`)
- BrowserTile resize remount fixed (`sizeRef`); webview popups routed via main `setWindowOpenHandler` → IPC → `dispatchOpenLink`. (`BrowserTile.tsx`, `secure-web-preferences.ts`, `preload/index.ts`, `env.d.ts`)
- Privacy: dropped `|| !context.gitRemoteUrl` — no-remote repos no longer leak workspace path to cloud. (`privacy/provider-context-policy.ts`)
- `fs:readFile`/`readDir` throw on EACCES/EPERM (return `''`/`[]` only on ENOENT) — no silent overwrite-with-empty. (`ipc/fs.ts`)
- localProxy: removed wildcard CORS (loopback-only, no renderer fetch). (`ipc/localProxy.ts`)
- Daemon: `runJob` body wrapped to emit error+done per job; `unhandledRejection` log-and-continue instead of killing all jobs. (`chat-jobs.mjs`, `codesurfd.mjs`)
- Dreaming: `permissionMode:'plan'` (structural read-only) instead of relying on `canUseTool` under bypass. (`vendor/dreaming.mjs`)
- Canvas workspace-switch: `flushPendingSave(outgoingId)` before switch + auto-save gated on `canvasLoadedForWorkspaceIdRef` — no lost edits, no cross-contamination. (`useCanvasEngine.ts`, `useAppWorkspaceOrchestration.ts`, `App.tsx`)

Verification: full-project `tsc --noEmit` = 10 errors, all pre-existing baseline, none in any touched file; all daemon `.mjs` pass `node --check`.

## BACKLOG (documented, not yet fixed)

Lower-value hardening/perf from `docs/CODE_REVIEW.md`, with file:line there:
- **CR-3 follow-up (largest):** power-plugin `node` execution still raw `require()` into main — the utilityProcess/broker rearchitecture is deferred (documented in `docs/plugins/00-architecture.md` §14). Current posture: defense-in-depth gate + load-time warnings + workspace/catalog default-OFF.
- OWL: multi-char text input only delivers first char; supervisor silent state-loss on crash; webview URL scheme allowlist.
- Codex stdout backpressure / unbounded stderr buffers; `turn.failed`/`error` events dropped.
- `session-sources.ts`: `Math.max(0, len*-1)` duplicate message ids; large-codex fast-path full-file scan; split the 2370-LOC monolith.
- Pi runtime per-turn session/subscription leak; Claude abortController never aborted.
- KanbanCard / FileExplorer missing memoization + watch debounce; Sidebar multi-effect reconciliation.
- Daemon: process-group kill for child descendants; lock file for duplicate-daemon race; uncapped command-output length in timeline.
- Lows: temp-file litter sweep, unbounded `nextZIndex`, `canvas_pan_to` coord math, keychain password cache lifetime, chrome temp-DB perms/sweep, `peer_set_state` status `as any`, SSE client Set cleanup, event-bus wildcard sub leak, NoteTile innerHTML hardening.

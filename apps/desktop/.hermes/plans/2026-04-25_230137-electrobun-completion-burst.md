# Electrobun Completion Burst — Core Runtime Parity

Date: 2026-04-25 23:01:37
Repo: `/Users/jkneen/clawd/collaborator-clone`
Branch: `main` / `origin/main` ahead locally

## What changed

This burst moved the Electrobun work beyond a boot spike into usable core runtime parity while keeping Electron intact.

### Core API/runtime parity

Updated `/Users/jkneen/clawd/collaborator-clone/electrobun/bun/index.ts` to implement real handlers for the renderer-facing `window.electron.*` facade, including:

- workspace/project JSON-backed create/list/set-active/delete/add/remove/rename flows
- settings read/write/raw JSON flows
- canvas/tile persistence plus local session listing/get-session-state
- queued-message event append
- file read/write/create/delete/rename/stat/copy/writeBrief flows
- bus publish/history/channel info in memory
- tileContext get/set/delete in memory
- activity upsert/query/byTile/byAgent/delete/clearTile in memory
- git status/branches/checkout/createBranch via git CLI
- execution host resolution to the local Electrobun runtime
- MCP config reads from `~/.codesurf/mcp-server.json`
- daemon/updater/local-proxy/chrome-sync UI-safe runtime responses

### Terminal parity

Bun can import `node-pty`, but the actual PTY spawn smoke hung under Bun in this repo. Node works.

To get a real terminal instead of a fake/no-op:

- Added `/Users/jkneen/clawd/collaborator-clone/electrobun/helpers/pty-host.cjs`
- Electrobun Bun runtime now spawns that helper with Node.
- The helper owns `node-pty` sessions and streams JSONL events back to Electrobun.
- Electrobun broadcasts terminal events to the renderer using the existing facade channels:
  - `terminal:data:${tileId}`
  - `terminal:active:${tileId}`
- Implemented terminal create/write/cd/resize/destroy/detach/updatePeers routing.

Standalone PTY helper verification passed:

```bash
node electrobun/helpers/pty-host.cjs
# create command with shell -lc 'printf pty-ok; exit 0'
# observed: pty_host_ok
```

### Chat/stream parity

Implemented local CLI provider routing in Electrobun:

- `chat:send` / `chat:resumeJob`
- `chat:stop`
- `chat:clearSession`
- `chat:selectFiles`
- `chat:writeTempAttachment`
- `chat:loadSessionHistory` UI-safe empty response

Real local provider paths:

- Hermes via `hermes chat --query ... --quiet --source tool`, using shared `buildHermesChatArgs()`
- Codex via `codex exec --json ...`, with streamed JSONL parsing for:
  - session events
  - assistant text
  - command summaries
  - file-change summaries

Events are emitted on the existing renderer event path:

- `agent:stream` with `{ cardId, ...event }`

Unsupported providers now fail visibly but safely in the chat UI instead of silently pretending to work:

- Claude SDK runtime path still needs a runtime-neutral extraction from Electron `chat.ts`
- OpenCode/OpenClaw still need their server/CLI parity extraction

### BrowserTile guardrail

Updated `/Users/jkneen/clawd/collaborator-clone/src/renderer/src/components/BrowserTile.tsx`:

- Feature-detects real Electron `<webview>` API.
- If unavailable under Electrobun/native WebView, creates an iframe-backed browser surface with a webview-like method shim.
- Provides no-crash implementations for:
  - `loadURL`
  - `getURL`
  - `getTitle`
  - `canGoBack`
  - `canGoForward`
  - `isLoading`
  - `goBack`
  - `goForward`
  - `reload`
  - `stop`
  - `setUserAgent`
  - `openDevTools`
  - `insertCSS`
  - `executeJavaScript`
  - `send`
- Dispatches fallback events:
  - `dom-ready`
  - `did-start-loading`
  - `did-navigate`
  - `did-stop-loading`
  - `did-fail-load`

This is a guarded fallback, not full Electron webview parity. It prevents renderer crashes and keeps navigation usable where sites allow iframe embedding. Full parity still needs a dedicated Electrobun BrowserView/WebView adapter.

### Packaging/runtime config

Updated `/Users/jkneen/clawd/collaborator-clone/electrobun.config.ts` to copy:

- `electrobun/helpers` -> `helpers`

so packaged Electrobun builds include the PTY helper.

## Verification

Passed:

```bash
node --test test/electrobun-facade.test.ts
# facade_test_exit=0

npm run build:renderer
# renderer_build_exit=0

bun run build:electrobun
# electrobun_build_exit=0

npm test
# npm_test_exit=0

npm run build
# electron_build_exit=0
```

Electrobun smoke launch:

```bash
CODESURF_ELECTROBUN_FORCE_BUNDLED=1 bun run run:electrobun
```

Result:

- process stayed running for 10 seconds
- verified with `ps -p <pid>`
- killed after smoke verification
- no stdout was emitted by `electrobun run` in this run, so the verification is process liveness rather than log-marker based

Typecheck:

```bash
npx tsc --noEmit --pretty false
# tsc_exit=2
```

Current `tsc` failures remain broader repo failures. New BrowserTile fallback errors introduced during this burst were fixed. Remaining BrowserTile entries match pre-existing failure categories from `/tmp/codesurf-tsc-3.log` after line-number shifts:

- `Type 'number' is not assignable to type 'Timeout'`
- `Promise<unknown>` callback typing around Cluso toggle
- missing theme `overlay`

## Known remaining cutover gaps

Electron can still not be deleted yet because these are still real gaps:

1. DB layer still uses `better-sqlite3`; Bun compatibility remains blocked. Needs `bun:sqlite` adapter or Node DB helper.
2. Claude SDK runtime path is still Electron-main-code-owned; needs extraction or a helper.
3. OpenCode/OpenClaw need provider-specific runtime-neutral extraction.
4. BrowserTile fallback is not full BrowserView parity; iframe embedding is limited by site headers.
5. Electron protocol/session/permission/updater equivalents still need final cutover work.

## Current git status after cleanup

Generated `build-electrobun/` and `artifacts-electrobun/` were removed after verification.

Expected worktree changes from Electrobun work:

- `package.json`
- `bun.lock`
- `electrobun.config.ts`
- `electrobun/`
- `src/electrobun/`
- `src/shared/electrobun-rpc.ts`
- `src/renderer/src/components/BrowserTile.tsx`
- `test/electrobun-facade.test.ts`
- `.hermes/`

Unrelated/local generated changes still present and not touched:

- `.codesurf/DREAMING.md`
- `.mcp.json`

No commit was made.

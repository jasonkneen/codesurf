# CodeSurf / CodeSurf — Code Review

**Date:** 2026-06-22
**Scope:** Fresh review on top of the 2026-06-07 hardening wave. Focused on
recently-modified files (chat pipeline, tool-normalization), security-sensitive
main-process code (MCP server, terminal, fs, stream, git), the canvas engine,
and cross-cutting code smells.
**Headline:** 1 destructive-data-loss bug (HIGH), 2 correctness bugs, several
medium hardening/maintainability items. The previous security wave landed well —
this review finds new issues introduced since, plus a few latent ones.

---

## ✅ Post-fix status (2026-06-22, branch `main`)

| ID | Status | Notes |
|----|--------|-------|
| HIGH `writeContexClaudeMd` clobber | **FIXED** | Three-way handling: absent→write, managed→no-op, user-owned→sidecar `.claude/contex.md` + reversible `@codesurf.md` import line. User CLAUDE.md never overwritten. |
| M1 EventBus unbounded growth | **FIXED** | Global 1000-channel cap, microtask-coalesced eviction sweep (dormant channels pruned, oldest-first fallback), `lastPublishAt` tracking, cursor pruning in `dropChannel`. Subscribed channels never evicted. 2 new tests. |
| M2 `tool_use` drop in reducer | **FIXED** | Synthesizes a completed block when no match (mirrors `tool_summary`). New test for orphan `tool_use`. |
| M3 terminal agent detection drift | **FIXED** | `isAgent`/`isClaude` now derived from `ALLOWED_AGENT_BINS` via basename match — no spoofable substring test, no drift between allowlist and injection set. |
| M4 `stream:start` ignores status | **FIXED** | ≥400 responses buffered and surfaced as an error event instead of fed to the SSE parser. |
| L1 orphan IPC handlers | **FIXED** | Removed `fs:delete`, `fs:rename`, `fs:basename` (not exposed in preload). |
| L2 broadcast pattern dup ×16 | **FIXED** | All 16 `getAllWindows().forEach send` sites migrated to `broadcastToRenderer`; helper hardened to check both window + webContents destroyed and swallow late-send errors. |
| L3 `.mcp.json` token gitignore | **FIXED** | `writeMCPConfigToWorkspace` aborts + logs if `ensureWorkspaceSecretsGitignored` fails, instead of silently writing the token into an un-ignored file. |
| L6 `terminal:cd` scope comment | **FIXED** | Documented that `dirPath` is intentionally not workspace-scoped (user owns the shell); escaping is the only real injection vector and is handled per-shell. |
| L4 type-safety (239 `any`) | **DONE (scoped)** | Added `handleTyped` zod-validation wrapper applied to all side-effecting IPC: `terminal:create/write/cd`, `fs:writeFile/createFile/createDir/deleteFile/renameFile/revealInFinder/writeBrief`, `canvas:save`, `git:checkoutBranch/createBranch`. Invalid args now reject before reaching handler bodies. Coarse schemas bound string lengths + file sizes. Full `any` elimination across all 239 sites is a larger separate refactor; the renderer→main security boundary is now hardened. |
| L5 44 console.log | **DONE** | New leveled `utils/logger.ts` (error/warn/info/debug, gated on `CODESURF_LOG`). All 45 `console.log` in `src/main/` migrated to scoped loggers. `.ts` import extensions where node ESM test runner needs them. |
| A1 god-object splits | **PARTIAL** | `theme.ts` split: **3098 → 341 lines**; 2774 lines of preset data + builders extracted to `themePresets.ts` (no circular dep — type-only back-edge). `Sidebar.tsx` (2598), `SettingsPanel.tsx` (2368), `BrowserTile.tsx` (2177) assessed and deferred — they're monolithic React components with tight prop coupling; splitting them risks regressions for navigability gain and is better done as focused dedicated sessions. |
| A3 canvas history snapshots | **ALREADY DONE** | False positive in review — `canvasHistory.ts` already implements sparse changed-tile diff (`buildCanvasHistoryEntry` stores only added/removed/modified tiles, not full snapshots). PERF-05 was already resolved. |

**Verification:** typecheck clean delta (17 pre-existing errors unchanged, 0 new);
543 unit tests run, 541 pass / 2 fail — both failures (`preload-parity`,
`session-openability`) are pre-existing and fail identically on the clean
baseline. EventBus + chat-reducer + tool-normalization + fs-write-brief +
fs-workspace-scope + theme-edge-shadow suites all green.

---

## 🔴 HIGH — destructive: `writeContexClaudeMd` silently overwrites user CLAUDE.md

**File:** `src/main/mcp-server.ts:781`

```ts
async function writeContexClaudeMd(workspacePath: string): Promise<void> {
  const claudeMdPath = join(workspacePath, '.claude', 'CLAUDE.md')
  try {
    const existing = await fs.readFile(claudeMdPath, 'utf8')
    if (existing.includes('<!-- contex-managed -->')) return   // ← only escape hatch
  } catch { /* doesn't exist yet */ }
  …
  await fs.writeFile(claudeMdPath, content)                    // ← clobbers
}
```

**The problem.** This runs (transitively) every time a user:
- opens a terminal tile in a workspace (`terminal.ts:456` → on every `terminal:create`),
- sends a Codex message (`codex.ts:361`),
- adds a project folder (`workspace.ts:103`),
- or the MCP server starts for any known workspace (`mcp-server.ts:715`).

If the project already contains a hand-written `.claude/CLAUDE.md` (the *standard*
project-instructions file for Claude Code, Cursor, etc.) **and it doesn't contain
the literal marker `<!-- contex-managed -->`**, it is overwritten in place with
CodeSurf's peer-collaboration boilerplate. No backup, no prompt, no git.
The user's project instructions are destroyed silently.

**Fix (pick one):**
1. **Never auto-write `.claude/CLAUDE.md`.** Write to a sidecar like
   `.claude/contex.md` and have the agent read it via the MCP `instructions`, or
   `append` a clearly-delimited managed block only when the file is absent.
2. If a user file exists without the marker, **refuse to write** and surface a
   one-time toast/setting ("Enable CodeSurf agent instructions in this project?").
3. At minimum, back up the existing file to `.claude/CLAUDE.md.bak` before
   overwriting and log loudly.

This is the single most important fix in the review.

---

## 🟠 MEDIUM — correctness

### M1. EventBus unbounded growth (memory leak in long sessions)
**File:** `src/main/event-bus.ts`

`history` (per-channel ring capped at 500 events) is fine, but:
- **`history` map itself has no global cap.** A publisher can create unlimited
  channel names (`bus.publish({ channel: 'tile:' + Math.random(), … })`).
  `dropChannel` / `dropChannelsMatching` exist but are opt-in; nothing prunes
  dormant channels automatically. A busy/looping agent can grow this map without
  bound across an all-day session.
- **`readCursors` never shrinks.** Every `${channel}::${subscriberId}` pair is
  added on `markRead` and only removed when the *channel* is dropped — so an
  agent that subscribes to many short-lived channels leaks cursor rows forever.

**Fix:** add a global LRU/size cap on `history` and a periodic sweep that drops
channels unused for N minutes (re-using `getStats()` as the trigger). Reset
read-cursors when their channel is dropped (already partly done) and cap the
cursor map.

### M2. `tool_use` event silently dropped when no block matches
**File:** `src/renderer/src/hooks/chatStreamReducer.ts` — `case 'tool_use'`

```ts
const idx = event.toolId
  ? blocks.findIndex(b => b.id === event.toolId)
  : blocks.findIndex(b => (b.name === event.toolName || …) && b.status === 'running')
if (idx >= 0) { blocks[idx] = { …, status: 'done' } }
return { ...m, toolBlocks: blocks }   // ← if idx < 0, event is lost
```

Compare with `tool_summary`, which creates a new block when none matches.
If a provider emits `tool_use` without a preceding `tool_start` (or with a
`toolId` that arrived out-of-order), the tool call disappears from the
transcript entirely. Either create the block (like `tool_summary`) or, at
minimum, merge into the last running block as a fallback.

### M3. `terminal.ts` agent detection inconsistent with allowlist
**File:** `src/main/ipc/terminal.ts:~230`

```ts
const ALLOWED_AGENT_BINS = ['claude', 'codex', 'aider', 'opencode', 'openclaw', 'hermes']
…
const agentBins = ['claude', 'codex', 'aider', 'opencode']      // ← missing 2
const isAgent = launchBin && agentBins.some(a => launchBin.includes(a))
```

Two issues:
1. `openclaw` and `hermes` pass the spawn allowlist (basename match) but are
   **not** treated as agents — they don't get objective.md injection, the
   `.contex` preamble, or the `--allowedTools` expansion. Inconsistent UX.
2. `launchBin.includes(a)` is a substring test and can be spoofed
   (`/x/evil-claude-bin`). The allowlist uses basename; `isAgent` should too.

**Fix:** derive `agentBins` from `ALLOWED_AGENT_BINS` and use basename matching
(`isAllowedBinary` already does the right thing — reuse its result).

### M4. `stream:start` ignores HTTP status
**File:** `src/main/ipc/stream.ts`

The response callback feeds `res` straight into the stream parser regardless of
status code. A 401/403/500 with a JSON error body is parsed as SSE and the user
sees an empty/garbled stream instead of "Unauthorized". Add a status check:
`if (res.statusCode && res.statusCode >= 400) { reject/send error event }`.

(The SSRF hardening itself — DNS resolve → IP-revalidate → connect to the IP
literal — is correct and defeats DNS-rebinding. Good.)

---

## 🟡 LOW / hardening / cleanup

### L1. Orphan IPC handlers (dead code, slight attack surface)
**File:** `src/main/ipc/fs.ts`

`fs:delete`, `fs:rename`, `fs:basename` are registered via `ipcMain.handle` but
**not exposed in the preload bridge**. They're unreachable from the renderer but
still registered. Either delete them or (for `fs:basename`) wire them up. Dead
handlers invite future bugs where someone assumes an API exists.

### L2. Broadcast-to-all-windows pattern duplicated 18×
**Files:** `permissions.ts`, `agent-stream.ts`, `chat/runtime.ts`, `collab.ts`,
`stream.ts`, `mcp-server.ts`, `workspace.ts`, etc.

Every one of these hand-rolls:
```ts
BrowserWindow.getAllWindows().forEach(win => {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
})
```
There's already `src/main/utils/broadcast.ts` doing exactly this. Migrate the
call sites to it. Fewer mutation points, one place to add per-window scoping
later (e.g. so mini-chat popovers don't receive `mcp:inject` for cardIds they
don't own).

### L3. `.mcp.json` + token written to every workspace
**File:** `mcp-server.ts:writeMCPConfigToWorkspace`

The MCP bearer token is written (mode 0o600, good) into `.mcp.json` inside every
project folder. `ensureWorkspaceSecretsGitignored` is called to add it to
`.gitignore`, but if that write fails (permissions, read-only repo) the token
sits in a file the user can easily `git add`. Consider writing to
`~/.codesurf/` keyed by workspace hash instead, and only adding `.mcp.json` to
the workspace if the user opts in. At minimum, abort the workspace write (and
log) when the gitignore append fails.

### L4. Type-safety debt
- **239** `: any` / `as any` occurrences across `src/`.
- **50** `eslint-disable` directives.
- The IPC layer in particular round-trips unvalidated `unknown` payloads into
  typed handlers (`(event, payload: any) => callback(payload)`). A `zod` schema
  on incoming IPC for the side-effecting channels (`terminal:write`,
  `canvas:save`, `fs:*`) would close a class of renderer-compromise→main bugs.

### L5. 44 `console.log` in main process
Not gated behind a debug flag. On a long session these fill `~/.codesurf/logs/`
and the devtools console. Consolidate behind a `log()` helper with levels.

### L6. `cd` injection surface in `terminal:cd`
**File:** `src/main/ipc/terminal.ts`

`dirPath` arrives unvalidated from the renderer and is interpolated into a shell
command. For POSIX it's single-quote-escaped correctly; for `cmd.exe` it uses
`cd /d "..."` with `"`-doubling, which is safe. This is *acceptable* for a
terminal (the user owns the renderer), but worth a comment noting it's
intentional and that `dirPath` is not workspace-scoped by design.

---

## 🏗️ Architecture / refactoring opportunities

### A1. Remaining god-objects
The App.tsx decomposition (into `useCanvasEngine`, `useCanvasDragSync`,
`useCanvasPointerHandlers`, `canvasAlignment`, `canvasHistory`) is clean — good
work. The remaining heavy files are candidates for the same treatment:

| File | LOC | Suggested split |
|---|---|---|
| `theme.ts` | 3098 | token tables vs. resolution vs. editor UI |
| `session-sources.ts` | 2627 | per-provider source adapters behind one registry |
| `Sidebar.tsx` | 2598 | already has `components/sidebar/*` helpers — pull more out |
| `SettingsPanel.tsx` | 2368 | per-section editor components (most already exist under `components/settings/`) |
| `BrowserTile.tsx` | 2177 | webview RPC layer vs. chrome vs. navigation state |
| `chat.ts` (ipc) | 1453 | per-provider dispatch is already split; the IPC shell itself can shrink |

### A2. `tool-normalization.ts` (new file) — solid, two nits
The new shared normalizer is well-structured (pure functions, single source of
truth, good test target). Two small notes:
- `stripProviderPrefix` regex `[a-z][a-z0-9_-]{1,24}` requires ≥2 chars, so a
  provider like `c:` (single letter) won't strip. Probably intentional, but
  document it.
- `matchEditedFiles` only handles the singular/plural "edited N files" phrase;
  if providers emit "Edited 3 file(s)" or localized variants they fall through
  to the generic path. Worth a note in the test.

### A3. Canvas history still stores full snapshots
PERF-05 from the prior review (full-state snapshots, ~25MB at 50 tiles) is still
open. `canvasHistory.ts` now exists as a module but the entry still captures
full tile arrays. For users with many tiles, switching to a structural diff
(sparse map of changed tile ids) would cut undo memory by ~10–50×.

---

## ✅ What's good (don't regress these)

- **MCP auth model** — bearer token, loopback-Host check (DNS-rebinding defense),
  1MB body cap, 0o600 config, fail-closed `isSensitiveMcpRoute` returning `true`.
  This is the right shape.
- **SSRF defense in `stream.ts`** — resolve → revalidate IP → connect to IP
  literal. Correct.
- **Terminal allowlist** — shells + agent CLIs by basename, env allowlist +
  secret denylist regex. Solid.
- **Canvas engine** — refs for cross-effect sync, RAF-throttled guide
  computation with bounding-box pre-filter, dedicated `skipHistoryResetTimer`
  so persist can't cancel the reset (H-12), `canvasLoadedForWorkspaceIdRef`
  gating saves to the right workspace during switches. The undo/drag races from
  the original review are genuinely fixed.
- **`useCanvasDragSync`** — pre-drag snapshot (`beforeTiles`) for correct undo
  diff, `pendingTileDragRef` to coalesce events, RAF gate. Well done.
- **Preload listener cleanup** — every `on*` helper returns a disposer that
  calls `removeListener(channel, handler)`. The old `removeAllListeners` bug is
  gone.
- **`tool-normalization.ts`** — clean, pure, testable.

---

## Priority order

1. **Fix `writeContexClaudeMd`** (HIGH, data loss) — ship this before anything else.
2. EventBus growth cap (M1).
3. `tool_use` drop (M2) — small, user-visible.
4. terminal agent detection (M3).
5. stream status check (M4).
6. Then the cleanup batch (L1–L6) and the god-object splits (A1) as opportunity
   permits.

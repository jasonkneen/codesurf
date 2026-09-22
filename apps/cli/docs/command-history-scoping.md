# Command History — Scoping

Status: draft / pre-implementation
Target area: `src/ui/app.tsx`, `src/ui/hooks/`, `src/storage/`

## Codebase anchors (why the estimate is grounded)

- TUI is **OpenTUI**, not Ink. The composer is a `TextareaRenderable` (`inputRef` at `src/ui/app.tsx:863`), and keys flow through `renderer._internalKeyInput.onInternal("keypress", …)` — not React's `useInput`. That's where Up/Down must be intercepted.
- Persistence is a **versioned SQLite schema** (`PRAGMA user_version`, currently 2, see `src/storage/migrations.ts`). Command history has a natural home: either derived from `messages` or a new dedicated `prompt_history` table.
- A **typeahead overlay** (`src/ui/hooks/useTypeahead.ts`) and a **command palette** already exist. Any history UI competes for the same input focus and arrow-key events — this is the real design pressure, not the storage.

## First — which flavor of "command history"?

These are very different features. Cost differs by ~5×.

| Flavor | What it does | Rough effort |
|---|---|---|
| **A. Shell-style recall** | Up/Down in the composer cycles prior submitted prompts | Small (1 day) |
| **B. Reverse search (Ctrl-R)** | Fuzzy-search prior prompts, inline | Medium (2–3 days) |
| **C. History modal/picker** | Full-screen browsable log (like `sessions-modal.tsx`) | Medium (2 days) |
| **D. Cross-session global history** | Recall prompts from *any* past session, scoped per-workspace | Adds ~½ day on top of A/B |
| **E. Slash-command history** | Only `/command` invocations, not free-text prompts | Small-medium; needs a command registry audit |

Most users asking for "command history" mean **A**, possibly **A+D**. Everything below assumes that.

## What's involved for A (+ optionally D)

### 1. Storage decision (the meaningful one)

Three reasonable places for history:

- **In-memory only** — ring buffer in a `useRef`. Dies on exit. Zero persistence code.
- **Derive from `messages` table** — query `role='user'` rows; no schema change. But: inputs get rewritten (paste-block tokens, `@mention` expansion) before hitting `messages`, so recall would replay the expanded form, not what the user typed. Surprising UX.
- **New `prompt_history` table** — stores the *raw submitted text* (pre-expansion), with `workspace_id`, `session_id`, `created_at`, optionally `was_command BOOLEAN`. Clean, migratable to schema v3.

**Recommendation:** new table. `handleSubmit` at `src/ui/app.tsx:4416` has both `raw` and `message` in scope — log `raw` **before** the paste/`@mention` expansion on lines 4432–4439, which is what a shell-style recall should restore.

### 2. Key interception — the real work

OpenTUI's `TextareaRenderable` owns Up/Down natively for caret movement. Interception must be **conditional**:

- On **Up**: if cursor is on the first visual line **and** `historyIndex` isn't at the tail → recall previous entry. Otherwise let the textarea handle it.
- On **Down**: symmetrical — last line + not at tail.
- **Esc or any edit** → reset the history cursor (classic bash/zsh behavior).

This is the only subtle piece. It must play nicely with:
- The existing `useTypeahead` overlay (when the suggestion list is open, arrows belong to it — see `src/ui/components/SuggestionOverlay.tsx`)
- The BTW overlay (`btwStateRef`)
- Queued-message mode when `isProcessingRef.current` is true
- Paste blocks — recalled entries must **not** re-create paste blocks; they should be restored as plain expanded text, or the original paste-block tokens won't resolve.

### 3. A hook to centralize it

Mirror the `useTypeahead` pattern: a `usePromptHistory(inputRef, { workspaceId })` that:
- Loads the last N (say 200) entries on mount
- Exposes `{ recallPrev, recallNext, reset, record }`
- Registers one `keypress` listener scoped by the same conditions typeahead uses

Then `handleSubmit`:
- calls `history.record(raw)` after line 4428 (`inputRef.current?.clear()`)
- and the shared key handler calls `recallPrev` / `recallNext`

### 4. Secret redaction (don't skip)

Users paste API keys. Options:
- Skip recording when the API-key modal is open (trivial — gate by modal state)
- Simple regex filter on common patterns (`sk-…`, `xai-…`, long hex) before insert
- Accept the risk and document it in `README.md`

This is a policy call.

### 5. Tests & migration

- `src/storage/migrations.ts` → add v3 creating `prompt_history`
- Unit-test the ring-buffer semantics (cursor reset, bounds, dedup of consecutive duplicates)
- Unit-test the "first line / last line" arrow gating — that's where regressions will show up

## Decisions needed before writing code

1. **A, B, C, or combo?** (Claude Code has A; most CLIs eventually grow to A+B.)
2. **Scope: session-only, workspace-scoped, or global?** Workspace-scoped is the sweet spot — `ensureWorkspace(cwd)` already exists.
3. **Dedup policy** — zsh's `HIST_IGNORE_DUPS` (skip only consecutive duplicates) or `HIST_IGNORE_ALL_DUPS` (remove all prior duplicates on repeat)?
4. **Secret redaction** — regex filter, or trust the user?

## Risk callouts

- The tempting shortcut — "just read prior `role='user'` messages" — produces surprising UX because inputs get rewritten before hitting `messages`. Logging `raw` pre-expansion at submit time avoids this bug class entirely.
- The riskiest hidden coupling is **arrow-key ownership**. Three subsystems want arrows (textarea caret, typeahead overlay, history recall). Without a clear precedence order, one of them will silently break.
- `app.tsx` is already 7,313 lines. Strongly prefer landing this as a new `src/ui/hooks/usePromptHistory.ts` + `src/storage/prompt-history.ts`, with ~10 lines of wiring in `app.tsx`.

## Default proposal (if no other input)

**A + workspace-scoped + consecutive-dedup + modal-gated redaction**, backed by a new `prompt_history` table at schema v3, implemented as a new hook with minimal wiring in `app.tsx`.

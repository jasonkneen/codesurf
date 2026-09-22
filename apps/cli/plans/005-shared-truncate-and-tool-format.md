# Plan 005: One truncate helper, one tool-format module, delete the dead settings export

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ed0f643..HEAD -- src/ui src/agent/agent-helpers.ts src/utils/settings.ts`
> If in-scope files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `ed0f643`, 2026-07-15

## Why this matters

"Truncate a string with an ellipsis" is implemented **seven times** in this
repo with **three drifted behaviors** (`…` after n chars; `…` within max;
ASCII `...` within max−3). Worse, `claude-code-status-line.tsx` re-declares
private copies of `toolArgs`/`tryParseArg`/`trunc` that its sibling
`message-list.tsx` already exports — and its `toolArgs` copy has silently
drifted (it handles fewer tool names, so status-line labels are worse than
chip labels for the same tool call). This is textbook DRY decay: cheap to fix
now, compounding if left. Also deletes one verified-dead export.

## Current state

The seven truncate implementations:

| Location | Behavior |
|---|---|
| `src/ui/components/message-list.tsx:146` (exported `trunc`) | `s.length <= n ? s : s.slice(0, n) + "…"` (result may be n+1 chars) |
| `src/ui/components/message-views.tsx:53` (`trunc`) | identical to message-list |
| `src/ui/components/claude-code-status-line.tsx:47` (`trunc`) | identical to message-list |
| `src/agent/agent-helpers.ts:29` (exported `truncate`) | `text.slice(0, max - 1) + "…"` (result ≤ max) |
| `src/ui/sessions-modal.tsx:50` (`truncate`) | `slice(0, max-1) + "…"` (≤ max) |
| `src/ui/feature-flags-modal.tsx:22` (`trunc`) | `max <= 1 → ""`, `slice(0, max-1) + "…"` (≤ max) |
| `src/ui/provider-settings-modal.tsx:11` (`trunc`) | `max <= 1 → ""`, `slice(0, max-3) + "..."` (ASCII, ≤ max) |

The duplicated tool formatters:

- `src/ui/components/message-list.tsx:88-106` — exported `toolArgs(tc)`: maps
  a tool call to its headline arg; handles bash/read/write/edit/generate_*/
  task/lsp/delegate/delegation_read/process_* and falls back to `a.query`.
- `src/ui/components/message-list.tsx:108-115` — exported `tryParseArg(tc, key)`.
- `src/ui/components/message-list.tsx:117-144` — exported `toolLabel(tc)`.
- `src/ui/components/claude-code-status-line.tsx:23-36` — private `toolArgs`
  **drifted copy**: only handles bash/read/write/edit/task/delegate + query
  fallback (missing lsp, generate_image/video, delegation_read, process_*).
- `src/ui/components/claude-code-status-line.tsx:38-45` — private
  `tryParseArg`, verbatim copy.

The dead export:

- `src/utils/settings.ts:486` — `export function getModeSpecificModel` has
  zero references anywhere in `src/` (verified:
  `grep -rn "getModeSpecificModel\b" src/` matches only the definition). The
  used sibling is `getModeSpecificModelSelection` at `settings.ts:490`.

Conventions: small pure UI helpers live in `src/utils/` (see
`src/utils/cli-check-cache.ts` for file style); Biome formatting, 2-space
indent; tests colocated as `*.test.ts` run via vitest.

## Commands you will need

| Purpose   | Command                                        | Expected on success |
|-----------|------------------------------------------------|---------------------|
| Install   | `bun install`                                  | exit 0              |
| Typecheck | `bun run typecheck`                            | exit 0, no errors   |
| Tests     | `bunx vitest run src/ui/ src/utils/text.test.ts` | all pass          |
| Status-line tests | `bun test src/ui/components/claude-code-status-line.test.ts` | pass (this file runs under `bun test`, see package.json `test:bun`) |
| Lint      | `bun run lint`                                 | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/utils/text.ts` (create) + `src/utils/text.test.ts` (create)
- `src/ui/components/tool-format.ts` (create)
- `src/ui/components/message-list.tsx`
- `src/ui/components/message-views.tsx`
- `src/ui/components/claude-code-status-line.tsx`
- `src/ui/sessions-modal.tsx`, `src/ui/feature-flags-modal.tsx`,
  `src/ui/provider-settings-modal.tsx`
- `src/agent/agent-helpers.ts`
- `src/utils/settings.ts` (Step 5 deletion only)
- Any file that imports the moved symbols (import-path updates only —
  discover with the greps in Step 3)

**Out of scope** (do NOT touch):
- `src/ui/slash-menu-inline.tsx` `truncateCell` and
  `src/ui/components/message-views.tsx` `truncateBlock`/`truncateLine` —
  these do width/line-aware work beyond plain truncation; leave them (they may
  CALL the new helper if trivial, but do not redesign them).
- Behavior of `toolLabel` — move verbatim.

## Git workflow

- Branch: `advisor/005-shared-truncate-and-tool-format`
- Conventional commits, e.g. `refactor(ui): single truncate + shared tool-format helpers`
- Do NOT push or open a PR (pushes are blocked on this repo by history-based
  push protection; commit locally only).

## Steps

### Step 1: Create the canonical truncate

Create `src/utils/text.ts`:

```ts
/** Truncate to at most `max` chars, ellipsis included. `max <= 1` returns "". */
export function truncate(text: string, max: number): string {
  if (max <= 1) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
```

DELIBERATE BEHAVIOR CHOICE (do not second-guess): the "result ≤ max" variant
wins because it is what the width-constrained call sites need; the
message-list variant's n+1-char result was an accident, and shrinking chip
labels by one character is imperceptible. The ASCII `...` in
provider-settings-modal is unified to `…` (every other UI string already uses
`…`).

Create `src/utils/text.test.ts` (mirror the style of
`src/utils/cli-check-cache.test.ts`): short string passes through; exact-max
passes through; long string is `max` chars ending in `…`; `max <= 1` → `""`.

**Verify**: `bunx vitest run src/utils/text.test.ts` → all pass.

### Step 2: Replace the seven copies

In each file from the table, delete the local `trunc`/`truncate` and import
`truncate` from `src/utils/text` (adjust relative paths; check how siblings
import from `src/utils/` and match). Where call sites used the old
message-list behavior (`trunc(s, n)` producing n+1 chars), keep the SAME call
arguments — the one-char difference is accepted.
In `agent-helpers.ts`, keep the export as a re-export for its existing
importers: `export { truncate } from "../utils/text";` (check the correct
relative path), or update its importers directly if there are ≤3
(`grep -rn "from .*agent-helpers" src/ | grep -i trunc` to find them).

**Verify**: `bun run typecheck` → exit 0;
`grep -rn "function trunc\b\|function truncate\b" src/ --include='*.ts' --include='*.tsx'`
→ only `src/utils/text.ts` (plus the out-of-scope `truncateCell`/
`truncateLine`/`truncateBlock` wrappers).

### Step 3: Extract the shared tool formatters

Create `src/ui/components/tool-format.ts` and MOVE (verbatim) from
`message-list.tsx`: `toolArgs`, `tryParseArg`, `toolLabel`, plus the
`ToolCall` type import they need. `message-list.tsx` re-exports them
(`export { toolArgs, tryParseArg, toolLabel } from "./tool-format";`) so
existing importers keep working — find them first:

```
grep -rn "toolArgs\|tryParseArg\|toolLabel" src/ --include='*.ts' --include='*.tsx' | grep "from\|import" 
```

Then in `claude-code-status-line.tsx`: delete the private `toolArgs`,
`tryParseArg`, and `trunc`; import from `./tool-format` and
`../../utils/text`. NOTE: this upgrades the status line to the FULL `toolArgs`
(the deleted copy handled fewer tools — e.g. `lsp`, `generate_image`,
`process_logs` now get proper labels instead of the `query` fallback). That is
the intended fix, not a regression.

**Verify**: `bun run typecheck` → exit 0;
`bun test src/ui/components/claude-code-status-line.test.ts` → pass.
If a status-line test asserts an exact label for one of the newly-handled
tools, update the expectation to the richer label and say so in the report.

### Step 4: UI test sweep

**Verify**: `bunx vitest run src/ui/` → all pass; also run the bun-native UI
tests: `bun test src/ui/components/prompt-bar.test.ts src/ui/components/claude-code-title-bar.test.ts` → pass.

### Step 5: Delete the dead export

First re-verify it is still dead:
`grep -rn "getModeSpecificModel\b" src/ --include='*.ts' --include='*.tsx'`
→ must match ONLY the definition at `src/utils/settings.ts:486`. Then delete
the function (definition only — `getModeSpecificModelSelection` at `:490`
stays).

**Verify**: `bun run typecheck` → exit 0; the grep now returns no matches.

## Test plan

- New: `src/utils/text.test.ts` (Step 1, 4 cases).
- Existing suites in Steps 3–4 guard the moved formatters (the status-line
  test file exercises `buildClaudeCodeStatusModel`, which consumes them).
- Report the net line delta (`git diff --stat`) — expect roughly −40 lines
  plus clearer ownership.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0 and `bun run lint` exits 0
- [ ] `bunx vitest run src/ui/ src/utils/text.test.ts` exits 0
- [ ] `bun test src/ui/components/claude-code-status-line.test.ts` exits 0
- [ ] Truncate-definition grep (Step 2) shows a single canonical definition
- [ ] `grep -rn "getModeSpecificModel\b" src/` → no matches
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The Step 5 grep finds a NEW caller of `getModeSpecificModel` (drift since
  planning) — skip the deletion and note it.
- A test failure suggests some UI genuinely depends on the ASCII `...` or the
  n+1-char truncation (e.g. a snapshot of exact column widths) and updating
  the expectation would change visible alignment by more than one character.
- The `toolArgs`/`tryParseArg` copies in status-line turn out to have any
  behavioral difference OTHER than the missing tool-name branches documented
  above.

## Maintenance notes

- New code should import `truncate` from `src/utils/text` — reviewers should
  flag any fresh private truncation helper.
- The status line now shares label logic with chips; a future label change in
  `tool-format.ts` affects both surfaces (that's the point — but reviewers
  should look at both in screenshots).
- Deferred: `slash-menu-inline.tsx`'s `truncateCell` and message-views'
  line/block truncators could delegate to `truncate` internally — left out to
  keep this diff mechanical.

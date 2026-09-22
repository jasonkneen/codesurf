# Plan 002: Stop re-rendering tool-chip subtrees and re-scanning the transcript on every MessageList frame

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ed0f643..HEAD -- src/ui/components/message-list.tsx src/ui/ai-output/tool-calls.tsx src/ui/ai-output/tool-call-block-list.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `ed0f643`, 2026-07-15

## Why this matters

This is a terminal React app (OpenTUI): rendering shares the single JS thread
with keyboard input, so wasted render work = typing lag. During an agent turn,
a viewport poll fires a `setViewport` state update many times per second
(`message-list.tsx:706-758`, fast path 16ms while `isProcessing`). Each such
update re-renders the `MessageList` component body. Individual message rows
are protected by a memoized `MessageView`, but the **tool-chip subtrees are
not**: chip records are rebuilt (including `JSON.parse` per tool call) and the
whole chip component tree re-renders on every frame. Separately, two
full-transcript regex scans for image paths run on every message commit. The
fix is memo boundaries + deduplicating an already-memoized derivation — no
behavior change.

## Current state

- `src/ui/components/message-list.tsx` — transcript renderer (the hottest UI
  path in the app).
  - Committed-chips branch inside the visible-slice `.map`,
    `message-list.tsx:998-1010` — rebuilds `records` inline on every render:
    ```tsx
    if (item.kind === "chips") {
      const records = item.entries.map(({ msg, index }) => entryToChipRecord(msg, `tc-${index}`));
      const topGap = realGi === 0 ? 0 : 1;
      return (
        <box key={`chips-${item.firstIndex}`} paddingLeft={3} marginTop={topGap} flexShrink={0}>
          {toolCallsPanel ? (
            <ToolCallBlockList t={t} calls={records} />
          ) : (
            <ToolChipGroup t={t} calls={records} dimToolChips={dimToolChips} onOpenFileLink={onOpenFileLink} />
          )}
        </box>
      );
    }
    ```
  - `liveRegularToolRecords` useMemo, `message-list.tsx:957-975` — memoized
    derivation of running-tool records (filters out `task`/`delegate`,
    `JSON.parse`es args, `enrichToolCallRecord`s). It is consumed by the
    compact path only.
  - Duplicate unmemoized copy of the same derivation in a trailing IIFE,
    `message-list.tsx:1146-1177` — recomputes `liveRecords` from
    `activeToolCalls` inline every render (same filter, same JSON.parse, plus
    `new Date()` per record).
  - "Special tasks" trailing IIFE, `message-list.tsx:1094-1141` — re-filters
    `activeToolCalls` for `task`/`delegate` and rebuilds step arrays inline
    every render.
  - `hasInlineImages`, `message-list.tsx:701-704` — regex-scans EVERY
    message on every `messages` change:
    ```tsx
    const hasInlineImages = useMemo(
      () => messages.some((entry) => extractImagePaths(entry.content || "").length > 0),
      [messages],
    );
    ```
  - `estimateItemHeight` calls `extractImagePaths` again per user item inside
    the `prefix` height-prefix useMemo (`message-list.tsx:~806` within the
    estimate function; the useMemo wrapping it is at `:840-845`).
  - The `items` array (message groups) is built in a `useMemo` keyed on
    `messages` — so `item.entries` array identities are stable across
    viewport-poll re-renders and only change when the transcript changes.
    Verify this by finding the `items` useMemo before starting.
- `src/ui/ai-output/tool-calls.tsx` — `ToolChipGroup`
  (`tool-calls.tsx:395-420`) is NOT wrapped in `React.memo`; it calls
  `deriveChipDisplay(calls, explodedGroups)` in the component body
  (`:411`) on every render. It holds internal state (`expandedDetails`,
  `explodedGroups`) — state updates re-render regardless of memo, which is
  what we want.
- `src/ui/ai-output/tool-call-block-list.tsx` — `ToolCallBlockList`
  (`tool-call-block-list.tsx:367+`) also unmemoized; recomputes
  `expandBlockListRecords` + per-row formatting (incl. `JSON.parse`) every
  render.
- Already done right (leave alone): `MessageView` memo + comparator
  (`message-list.tsx:504-586`), stream-store streaming isolation, all context
  provider values, `countHooksForTool` Map cache.

## Commands you will need

| Purpose   | Command                                        | Expected on success |
|-----------|------------------------------------------------|---------------------|
| Install   | `bun install`                                  | exit 0              |
| Typecheck | `bun run typecheck`                            | exit 0, no errors   |
| Targeted tests | `bunx vitest run src/ui/`                 | all pass            |
| Lint      | `bun run lint`                                 | exit 0              |
| Manual smoke | `bun run dev` then run a prompt that triggers tool calls | chips render/expand as before |

Note: the FULL vitest suite has ~9 known pre-existing failures under
`bunx vitest` (bun:sqlite in extension tests) — ignore those; `src/ui/` runs
clean.

## Scope

**In scope** (the only files you should modify):
- `src/ui/components/message-list.tsx`
- `src/ui/ai-output/tool-calls.tsx`
- `src/ui/ai-output/tool-call-block-list.tsx`

**Out of scope** (do NOT touch, even though they look related):
- The viewport polling mechanism itself (`message-list.tsx:706-758`) — its
  thresholds are load-bearing for sticky-scroll and Kitty-image clipping.
- `MessageView` / `MessageViewImpl` and the memo comparator at
  `message-list.tsx:504-586`.
- The stream-store / streaming leaf components.
- `src/ui/components/message-views.tsx`.

## Git workflow

- Branch: `advisor/002-message-list-chip-memoization`
- Conventional commits, e.g. `perf(ui): memoize tool-chip subtrees against viewport-poll re-renders`
- Do NOT push or open a PR (pushes are blocked on this repo by history-based
  push protection; commit locally only).

## Steps

### Step 1: Memoize `ToolChipGroup` and `ToolCallBlockList`

In `tool-calls.tsx`: wrap the `ToolChipGroup` export in `React.memo` and move
`deriveChipDisplay(calls, explodedGroups)` into a
`useMemo(() => deriveChipDisplay(calls, explodedGroups), [calls, explodedGroups])`.
Keep the export name and signature identical (named function inside `memo(...)`
so devtools names survive). Do the same for `ToolCallBlockList` in
`tool-call-block-list.tsx` (memo the component; useMemo its
`expandBlockListRecords(...)` derivation on `[calls]` plus whatever inputs it
actually reads — read the function before choosing deps).

**Verify**: `bun run typecheck` → exit 0; `bunx vitest run src/ui/` → all pass.

### Step 2: Give committed chip groups a stable-props memo boundary

In `message-list.tsx`, add a module-level memoized component next to the other
helpers:

```tsx
const ChipsItem = React.memo(function ChipsItem({
  entries,
  t,
  toolCallsPanel,
  dimToolChips,
  onOpenFileLink,
}: {
  entries: ChipEntries; // use the actual type of item.entries
  t: Theme;
  toolCallsPanel: boolean;
  dimToolChips: boolean;
  onOpenFileLink?: (target: LocalFileLinkTarget) => void;
}) {
  const records = React.useMemo(
    () => entries.map(({ msg, index }) => entryToChipRecord(msg, `tc-${index}`)),
    [entries],
  );
  return toolCallsPanel ? (
    <ToolCallBlockList t={t} calls={records} />
  ) : (
    <ToolChipGroup t={t} calls={records} dimToolChips={dimToolChips} onOpenFileLink={onOpenFileLink} />
  );
});
```

Replace the body of the `item.kind === "chips"` branch
(`message-list.tsx:998-1010`) with the surrounding `<box>` (unchanged key,
padding, marginTop logic) containing `<ChipsItem …/>`. Props passed must be
exactly: `item.entries`, `t`, `toolCallsPanel`, `dimToolChips`,
`onOpenFileLink`. IMPORTANT: confirm `onOpenFileLink` reaching MessageList is
referentially stable (it should arrive from a useCallback in the parent —
check `session-route.tsx`); if it is recreated inline at the call site, fix it
THERE with useCallback rather than excluding it from the memo.

**Verify**: `bun run typecheck` → exit 0. Manual smoke: run `bun run dev`,
trigger a few tool calls, confirm chips appear, expand/collapse on click, and
dim/panel modes still work (`/flags` toggles `toolCallsPanel`/`dimToolChips`).

### Step 3: Deduplicate the live-records derivation

In `message-list.tsx`, the trailing IIFE at `:1146-1177` rebuilds what
`liveRegularToolRecords` (`:957-975`) already memoizes. Replace the IIFE's
`liveRecords` computation with the memoized `liveRegularToolRecords` value
(the filter conditions are identical — verify by eye before swapping) and
delete the inline recomputation. Keep the `compactLiveStatus` early-return
logic exactly as is.

Then wrap the "special tasks" derivation (`:1094-1141`): hoist
`const specialToolCalls = useMemo(() => activeToolCalls.filter(tc => tc.function.name === "task" || tc.function.name === "delegate"), [activeToolCalls])`
above the return and use it in that block, so the per-frame filter+map only
runs when `activeToolCalls` changes identity.

**Verify**: `bun run typecheck` → exit 0; `bunx vitest run src/ui/` → all pass.

### Step 4: Cache `extractImagePaths` per committed entry

In `message-list.tsx`, add a module-level cache:

```tsx
const imagePathsCache = new WeakMap<object, { content: string; paths: string[] }>();
function cachedImagePaths(entry: { content?: string }): string[] {
  const content = entry.content || "";
  const hit = imagePathsCache.get(entry);
  if (hit && hit.content === content) return hit.paths;
  const paths = extractImagePaths(content);
  imagePathsCache.set(entry, { content, paths });
  return paths;
}
```

Use `cachedImagePaths(entry)` in BOTH sites: the `hasInlineImages` useMemo
(`:701-704`) and the `estimateItemHeight` user-branch call (`:~806`). The
`content` equality check makes this safe even if an entry object is mutated
while streaming.

**Verify**: `bun run typecheck` → exit 0; `bunx vitest run src/ui/` → all pass.

## Test plan

- Existing UI tests: `bunx vitest run src/ui/` must stay green (rendering
  logic tests live there, e.g. `src/ui/app.layout.test.ts`).
- No new unit tests are required for the memo boundaries (they're
  React-render-behavioral), but ADD one small test for `cachedImagePaths` if
  `extractImagePaths` already has a test file — mirror its location/style;
  cases: same entry twice returns the same array identity; changed content
  recomputes.
- Manual verification (this is the real gate): `bun run dev`, enable the FPS
  overlay feature flag (`render.fpsOverlay` via `/flags`), run a prompt that
  streams a long answer plus several tool calls, and confirm typing in the
  composer stays responsive during the turn. Chips must still expand/collapse,
  explode groups, and open file links.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bunx vitest run src/ui/` exits 0
- [ ] `grep -n "entryToChipRecord" src/ui/components/message-list.tsx` shows it
      called only inside `ChipsItem`'s useMemo (plus its definition)
- [ ] The inline `liveRecords` recomputation at the old `:1153` block is gone
      (`grep -n "JSON.parse(tc.function.arguments)" src/ui/components/message-list.tsx`
      matches only inside the `liveRegularToolRecords` useMemo)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at "Current state" locations doesn't match the excerpts.
- `item.entries` turns out NOT to be referentially stable across
  viewport-poll renders (i.e. the `items` useMemo is keyed on something that
  changes per frame) — the memo boundary would never hit and the plan's
  premise is wrong.
- The two live-record derivations (memoized vs inline) turn out to differ in
  any filter/mapping detail beyond formatting.
- Chip expand/collapse or file-link opening breaks in manual smoke and one
  honest fix attempt doesn't restore it.

## Maintenance notes

- Anyone adding props to `ChipsItem` must keep them referentially stable or
  the memo silently stops working; scrutinize this in review.
- If tool-chip UI later needs data from context instead of props, consume the
  context INSIDE `ChipsItem` (below the memo boundary), not in `MessageList`.
- Deferred (backlog): splitting `MessageList` (534-line component) into a
  `useTranscriptViewport` hook + chip-transform module (DEBT-22), and
  coalescing terminal-manager notifications (PERF-06). This plan deliberately
  keeps the diff small and behavior-neutral instead.

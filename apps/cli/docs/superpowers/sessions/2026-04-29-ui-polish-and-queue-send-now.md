# Session — UI polish + queue send-now (2026-04-29)

Mixed session: closed out the Phase 2 host-service-surface design proposal's advisor flags, then pivoted to three small UI/UX bugs the owner flagged from screenshots and live use.

## Scope

1. **Phase 2 #4+ host-service-surface design — final advisor flags** on `docs/superpowers/specs/2026-04-29-phase-2-host-service-surface-design.md`. Two leftovers from the prior compaction: tighten acceptance criterion 6, and add a step 7 test-suite-impact bullet.
2. **UI fix #1 — blue → primary in mode label.** Loading-box squares in the bottom-right status bar were hardcoded blue (`#5c9cf5` from `MODES`); should follow the active theme's primary so nerv shows orange.
3. **UI fix #2 — darken tool-call chips.** Owner's words: "darken these chips down a little so they are not as bright" — referring to BASH/GREP chips in the AI output area.
4. **UI feature — queue send-now.** "Send now does not work for queued messages, it would be nice to have an up arrow or something to press and send a queued message into the stream AND if we can cursor up to it too and hit enter that would be great."

No changes to behaviour outside these surfaces. No commits this session — owner-gated per global CLAUDE.md.

## Files changed

| File | Nature | Summary |
|---|---|---|
| `docs/superpowers/specs/2026-04-29-phase-2-host-service-surface-design.md` | Edits | Acceptance criterion 6 + step 7 test-impact bullet |
| `src/ui/app.tsx` | Code | `PromptModeLabel` theme-aware color; `dispatchQueueHead` helper; `handleSubmit` Enter-on-empty; `handleKey` ↑ on empty; `QueueBanner` hint flip |
| `src/ui/ai-output/tool-calls.tsx` | Code | Three chips: `textMuted`/`background` → `textDim`/`text` |

`bun run typecheck` clean after each step. `bun run lint` shows one preexisting unrelated warning (`SandboxPickerModal` unused import in `src/ui/app.tsx`) — not introduced by this work.

## What landed — design proposal

### Edit 14 — acceptance criterion 6

**Before:** "Migration of N tools from `createTools()` to host services results in the count of tools owned by `createTools()` decreasing by exactly N."

**After:** "Migration of N tools from `createTools()` to host services results in the count of `tool({...})` definitions executed from `createTools()` decreasing by exactly the number listed in step N's plan; no off-by-one drift (e.g. mode-gated tools migrating in pairs because `write_file` and `edit_file` already have metadata-only kernel registration via the mixed-mode file extension)."

The original criterion was fuzzy on what counts as "owned" — metadata-only registration in `groups.ts` confused the picture. The tightened criterion measures what actually moves: the executable `tool({...})` definitions inside `createTools()`. The parenthetical calls out the file-tools mixed-mode case explicitly so future agents don't trip on it.

### Edit 15 — step 7 test-impact bullet

Added to the step 7 risks section:

> Step 7's bash + hooks promotion will rewire ~28 tool definitions across the agent test surface. Expect order ~10–20 existing tests to require updates (delegation-manager spec, session-store spec, cwd-provider tests, plus any agent-run tests that touch bash). Step 7's plan should enumerate which test files are touched and budget separately for "modify existing" vs "add new" — the work isn't symmetric.

The original step 7 budget treated test work as a uniform lump; this bullet splits "modify existing" from "add new" because the existing surface is much larger than greenfield additions.

## What landed — UI fix #1 (blue → primary)

The bottom-right status bar shows the active mode (`AGENT`/`PLAN`/`ASK`) with optional loading-box squares while a turn is processing. The static `MODES` constant in `src/types/index.ts` hardcodes:

```ts
agent: "#5c9cf5"  // blue
plan:  "#e5c07b"  // gold
ask:   "#22c55e"  // green
```

Plan and ask are *semantic* — gold means "in plan workflow," green means "read-only Q&A." Agent's blue, however, is just a brand color that conflicts with theme-driven brands (nerv = orange).

**Decision:** resolve the color at render site, not in `MODES`. Only agent mode reads from the theme; plan/ask keep their semantic colors.

```tsx
function PromptModeLabel({ t, modeInfo, isProcessing }: {...}) {
  // Agent mode follows the active theme's primary so it matches the rest of
  // the brand (e.g. nerv's orange) instead of the static blue baked into
  // `MODES`. Plan/ask keep their semantic colors (gold/green) because they
  // signal *workflow state*, not theme identity.
  const color = modeInfo.id === "agent" ? t.primary : modeInfo.color;
  if (!isProcessing) {
    return <text fg={color}><b>{modeInfo.label}</b></text>;
  }
  return <PromptLoadingBoxes t={t} color={color} />;
}
```

No catalog churn (`MODES` stays as-is); all themes get the new behaviour automatically.

## What landed — UI fix #2 (darken chips)

`ToolChip`, `GroupChip`, and `MegaChip` in `src/ui/ai-output/tool-calls.tsx` shared this color scheme:

```tsx
backgroundColor={t.textMuted}  // mid-grey
<text fg={t.background} bg={t.textMuted}>...</text>  // light text on mid-grey
```

`textMuted` is meant for body text contrast, not chip backgrounds — it reads as too bright when used as a fill. Two `replace_all` edits flipped all three chip types:

- `t.textMuted` (background) → `t.textDim` (darker grey)
- `t.background` (foreground/text) → `t.text` (normal text)
- 3 occurrences of the background change, 6 occurrences of the foreground change

JSDoc on `ToolChip` updated to match: "filled block: subdued dark-grey background (`textDim`) with light text (`text`)."

No new theme slot, no alpha-mixing — just a swap to existing slots. All themes get the change automatically.

## What landed — queue send-now (Tier 1 + Tier 2)

The owner's request had three implicit tiers:

1. **Bug:** Enter on empty composer with queue+processing should send the head, not just abort.
2. **Shortcut:** ↑ on empty composer should do the same.
3. **Aspirational:** ↑ should let you cursor up *into* the queue, then Enter dispatches the focused item.

Tier 3 is materially different from 1+2 (needs `queueFocusIndex` state + focus-vs-composer ownership model). The owner's phrasing — "if we can cursor up to it too and hit enter *that would be great*" — flagged it as aspirational. Tier 1+2 landed; Tier 3 deferred until the owner confirms.

### What was actually broken

The pre-fix Enter-on-empty branch in `handleSubmit`:

```tsx
if (!raw.trim() && pasteBlocksRef.current.length === 0) {
  if (queuedMessagesRef.current.length > 0 && isProcessingRef.current) {
    interruptedRunIdRef.current = activeRunIdRef.current;
    const activeAgent = activeTurnRef.current?.agent ?? agent;
    activeTurnRef.current = null;
    clearLiveTurnUi();
    activeAgent.abort();
  }
  return;
}
```

The chain *should* fire: abort → stream throws → `finalizeActiveTurn(wasInterrupted=true)` → activeTurn null → `finishTurnProcessing()` → shifts head + dispatches next. But it dropped occasionally because the settle order depends on the agent's stream cancellation behaviour.

Also: the `↑ edit` hint in `QueueBanner` was vapor — no `up` handler existed for empty-composer + queue + processing anywhere in the keyboard handlers. Pure dead text.

### Direct dispatch — why it's race-safe

Factored a `dispatchQueueHead()` helper next to `finishTurnProcessing` (~line 1656 of `app.tsx`):

```tsx
const dispatchQueueHead = useCallback((): boolean => {
  if (queuedMessagesRef.current.length === 0 || !isProcessingRef.current) {
    return false;
  }
  const head = queuedMessagesRef.current.shift();
  if (!head) return false;
  setQueuedMessages(queuedMessagesRef.current.map((msg) => msg.displayText));

  interruptedRunIdRef.current = activeRunIdRef.current;
  const activeAgent = activeTurnRef.current?.agent ?? agent;
  activeTurnRef.current = null;
  clearLiveTurnUi();
  activeAgent.abort();

  // Clear the gate so processMessage's own `isProcessingRef.current` check
  // passes. processMessage will set it back to true synchronously before
  // it yields to the coordinator.
  isProcessingRef.current = false;
  void processMessageRef.current(head.text, head.displayText);
  return true;
}, [agent, clearLiveTurnUi]);
```

The race I worried about: what if `finishTurnProcessing` fires from the prior run's settle path *after* our direct dispatch, double-shifting the queue?

Tracing it:

- T0: `dispatchQueueHead` shifts head (item 1). Queue: [item 2, ...].
- T0: `processMessage(item 1)` runs synchronously up to `++activeRunIdRef.current` (line 2379) before yielding. `isProcessingRef.current` flips back to true.
- T1: prior run's stream errors out. catch fires. Line 2467: `wasInterrupted = (interruptedRunIdRef.current === runId)` → true. Line 2468: `isStale()` → `activeRunIdRef.current !== runId` → true. Line 2470: `return` early.
- The prior run *never reaches* `finalizeActiveTurn` → never calls `finishTurnProcessing`. No double-shift.

The existing `isStale()` check is the lock. Direct dispatch is safe because `processMessage` increments the runId synchronously before any await.

### Tier 1 wiring — handleSubmit Enter-on-empty

Replaced the abort-only branch with a single helper call:

```tsx
if (!raw.trim() && pasteBlocksRef.current.length === 0) {
  // Enter on an empty composer + queued messages + processing →
  // promote the head to "send now". Same shortcut as the ↑ key.
  dispatchQueueHead();
  return;
}
```

Updated the `handleSubmit` deps array: dropped `clearLiveTurnUi` (only used in the path we removed), added `dispatchQueueHead`.

### Tier 2 wiring — ↑ on empty composer

Inserted right after the typeahead block in `handleKey` (typeahead consumes ↑ when visible — this only fires when typeahead is dormant):

```tsx
// ↑ on an empty composer with queued messages while a turn is running →
// promote the head to "send now". Same path as Enter-on-empty in
// handleSubmit, just bound to a more discoverable shortcut (matches the
// QueueBanner's "↑ send" hint). Falls through to textarea cursor
// navigation if the gate doesn't match.
if (key.name === "up" && !shellModeRef.current) {
  const text = inputRef.current?.plainText || "";
  if (!text.trim() && pasteBlocksRef.current.length === 0 && dispatchQueueHead()) {
    key.preventDefault?.();
    key.stopPropagation?.();
    return;
  }
}
```

`dispatchQueueHead` returns `false` if there's nothing to dispatch, so it's safe to fall through to the textarea's own cursor navigation when the queue is empty or no turn is running.

`handleKey` deps array gained `dispatchQueueHead`.

### Tier 2 wiring — banner hint flip

The `QueueBanner`'s footer hint had `↑ edit` — vapor. Flipped to `↑ send` to match the new behaviour:

```tsx
<text>
  <span style={{ fg: t.primary }}>{"enter "}</span>
  <span style={{ fg: t.textMuted }}>{"send now"}</span>
  <span style={{ fg: t.textDim }}>{" · "}</span>
  <span style={{ fg: t.primary }}>{"↑ "}</span>
  <span style={{ fg: t.textMuted }}>{"send"}</span>     {/* was "edit" */}
  <span style={{ fg: t.textDim }}>{" · "}</span>
  <span style={{ fg: t.primary }}>{"esc "}</span>
  <span style={{ fg: t.textMuted }}>{"cancel"}</span>
</text>
```

## Lessons

- **Theme-aware color resolution belongs at render site, not in static catalogues.** When a constant mixes semantic colors (state-meaning) with brand colors (theme identity), don't try to make the catalogue dual-purpose. Resolve the brand-driven cases at render. Keeps the static constant declarative; keeps the theme system declarative.
- **`isStale()` is a free lock for direct-dispatch races.** When you need to interrupt-and-resume an async chain that uses runId-based staleness, a synchronous runId bump in the new dispatch invalidates the prior chain's settle path automatically. No new locking needed. This is the third sighting of "the existing isStale check saves us" in the kernel-extensibility / agent-loop work — pattern is canonical.
- **Three-tier scope ladders are good for ambiguous user requests.** "Send now does not work AND ↑ would be nice AND cursor-up-into-queue would be great" reads as one request; it's actually three layers with different complexity. The advisor's three-tier framing made the deferral of Tier 3 (focus-into-queue) explicit and defensible — owner's "would be great" maps cleanly to "land Tier 1+2, surface Tier 3 before building."
- **Dead-text hints are technical debt.** The `↑ edit` hint sat in `QueueBanner` for some unknown number of versions — no handler ever existed. The owner discovering it via the inverse path (asking for ↑-to-send and us discovering the dead hint *while* implementing) is a tell that hint text deserves the same `git grep` discipline as command names.
- **`replace_all` Edit on chip color slots was the right granularity.** Three chip types share an identical color shape. A single `replace_all` per slot (background, foreground) was cleaner than three separate per-component edits. Pattern works when the color is genuinely shared semantics, not coincidental duplication.

## Pending after this session

- **Tier 3 (queue focus-into navigation)** — owner-gated. State machine sketch in the prior session summary's "Pending Tasks" block. Don't build until owner confirms aspirational ask is real.
- **Phase 2 #4+ design proposal owner go/no-go** — proposal sits at `docs/superpowers/specs/2026-04-29-phase-2-host-service-surface-design.md` with all advisor flags resolved. No implementation yet.
- **Commit decision** — five uncommitted files in working tree (design proposal + 2 UI fixes + this session doc + future MEMORY/HEARTBEAT updates). Owner-gated.
- **Long-tail HEARTBEAT items** unchanged: Cluster C migration, `handleKey` per-modal split, MEMORY.md noise audit (1/3 done), persona-bootstrap skill promotion, hook-nudge router design (3rd request now).

## Verification

- `bun run typecheck` — clean after each substantive edit.
- `bun run lint` — one preexisting warning unrelated to this work (`SandboxPickerModal` unused import). My changes introduce no new warnings.
- Manual smoke deferred — UI changes need a human eye on the actual TUI. Owner's call.

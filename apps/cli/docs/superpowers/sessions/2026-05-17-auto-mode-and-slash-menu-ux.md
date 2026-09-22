# Session — Auto mode extension + slash-menu UX (2026-05-17)

Built a fire-and-forget agent loop as a pure builtin extension (no kernel changes) and fixed two
slash-menu friction points that surfaced during testing.

## Scope

1. **Auto mode** — new builtin extension `builtin.auto-mode`. Owner wanted "give it a task and not
   have to worry until it hits a max turns OR a blocker." Constraint: ship as an extension, not as
   a 4th `AgentMode` (which is a hardcoded union in `src/types/index.ts`).
2. **Slash menu only on empty composer** — typing `/` mid-message used to pop the menu and swallow
   the slash. Now `/` only opens the menu when the composer is empty; otherwise it inserts as a
   literal character.
3. **Tab-to-prefill in slash menu** — Enter on a menu item fires the command immediately. For
   commands that take arguments (`/auto <task>`, `/btw <q>`, `/term <cmd>`, every custom subagent)
   the user needs a way to select the command and *then* type the args. Added Tab handling that
   inserts `/<command> ` into the composer and closes the menu without firing.

No kernel changes. No new host services. Everything contributes through the existing
`ExtensionHostApi`.

## Files changed

| File | Nature | Summary |
|---|---|---|
| `src/core/extensions/builtin/auto-mode.ts` | NEW (~480 lines) | Extension + tool + 4 slash commands + status indicator + module state |
| `src/core/extensions/builtin/auto-mode.test.ts` | NEW | 18 tests covering manifest, registrations, state transitions, max-turns cap, resume flow |
| `src/core/extensions/builtin/index.ts` | 2-line edit | Import + array entry under "Agent loop wrappers" |
| `src/ui/input/useInputRouter.ts` | Edit | Optional `getInputValue` option; `/` gate reads it and only opens menu when composer is empty |
| `src/ui/app.tsx` | Edit | `getInputValue: () => inputRef.current?.plainText ?? ""` wired into the router; Tab handler in the slash-menu key block |
| `src/ui/slash-menu-inline.tsx` | 1-line edit | Header hint flipped from `""` to `"tab fill · enter run"` |

## Mechanism — how Auto mode works without core changes

The extension contributes a single tool (`auto_status`) and four slash commands. The seed prompt
instructs the model to call `auto_status` at the end of every Auto turn with a structured payload:

```ts
{
  state: "continue" | "blocked" | "done",
  phase: string,        // current sub-goal label
  did: string,          // one-line summary of this turn
  next: string,         // one-line plan for next turn
  risk: "reversible" | "needs-approval" | "irreversible-pending",
  checkpoint: string | null,  // git SHA or null
  why_blocked?: string  // required when state=blocked
}
```

The tool's `execute()` inspects the state and routes:

- `state: "continue"` → call `services.chat.dispatch("Continue. Next: …")` to **queue** the next
  user turn. The chat sink queues during an active turn and fires it once the current turn
  settles. This is the loop primitive — no new event hook needed.
- `state: "done"` → mark Auto inactive, write a summary via `services.chat.appendAssistant()`.
- `state: "blocked"` → mark inactive, write summary + resume options (`/auto-continue`, `/auto`,
  `/auto-stop`).

Max-turns enforcement happens before the dispatch: if `state.turnCount >= state.maxTurns`, the
loop stops with a cap-hit summary instead of dispatching.

### Why this works as an extension

Three primitives already in the kernel API made this clean:

1. **`api.registerTool({ tool: tool({...}) })`** — full-ownership tool registration. The kernel
   merges this into the active ToolSet.
2. **`services.chat.dispatch(prompt, { displayText })`** — UI-bound sink that queues during
   active turns. This is the loop's clock — every dispatch becomes the next turn.
3. **`services.chat.appendAssistant(content)`** — write directly to the transcript without
   invoking the model. Used for activation banner, summaries, and blocker prompts.

The status indicator (`▶ AUTO 23/200` in the footer) uses a tiny pub-sub + `useSyncExternalStore`
so it only re-renders on Auto state transitions, not on every host render.

## Safety policy — tier (a) via prompt, not kernel

The auto-approve scope ("only auto-approve reversible operations") is enforced in the seed prompt,
not in any kernel filter. The model is told to set `state="blocked"` before:

- Two-attempt rule trip (same approach failed twice)
- Test / typecheck / build regression after a fix attempt
- Ambiguous requirement
- Destructive op: `git push --force`, `git reset --hard`, `rm -rf` outside cwd, `paid_request`,
  dropping tables, force-deleting branches
- Any approval-required tool

The existing `tool.needsApproval()` flow still gates approval-required tools — Auto doesn't
bypass permission prompts, it just stops asking the model to second-guess reversible work.

## Slash commands shipped

| Command | Purpose |
|---|---|
| `/auto <task> [--turns N]` | Start a run (default 200 turns, hard cap 1000) |
| `/auto-continue [instruction] [--turns N]` | Resume after a blocker; optionally add new instruction or extend the cap |
| `/auto-stop` | Stop the current run |
| `/auto-status` | Show run state + turn history |

## Verification

- `bunx vitest run src/core/extensions/builtin/auto-mode.test.ts` — **18/18 pass**
- `bunx tsc --noEmit` — **0 errors**
- `bun run build` — **clean**, emits `dist/core/extensions/builtin/auto-mode.{js,d.ts}`
- `bunx biome check src/core/extensions/builtin/auto-mode.ts` — **clean**
- Full `src/core/extensions/builtin/` suite — **127 pass / 2 fail** (same 2 pre-existing failures as
  baseline; same 3 pre-existing failures persist in the wider extensions suite)
- `bunx biome check src/ui/input/useInputRouter.ts src/ui/app.tsx` — **10 errors, down from 13**
  baseline (auto-fixes from biome --write reduced the count; no new errors introduced)

## Lessons

- **Loop primitives without an event hook.** `services.chat.dispatch` queues during active turns
  and fires once the turn settles. That single property is enough to build a self-repeating loop
  inside a tool's `execute()` — no `onTurnEnd` event, no separate watcher, no kernel changes.
  Generalisable: any future "agent does N rounds then stops" feature can be a tool + a slash
  command + a piece of module state.

- **Two-stage command entry needs Tab.** Enter-on-menu-item is the right default for commands
  with no args (`/clear`, `/quit`, `/theme`) but breaks commands where args are mandatory. The
  fix was a single extra branch in the slash-menu key handler that reads `item.id`, prefills the
  composer with `/<id> `, and closes the menu. ~12 lines. Tab/Enter split mirrors standard shell
  completion conventions.

- **Don't intercept characters the user typed.** The original `/` shortcut intercepted the key
  regardless of composer state, which meant typing `src/foo/bar` opened the menu and dropped the
  slash. The fix was a 4-line gate: only open the menu when the composer is empty, otherwise let
  the `/` flow through. Implication: any global keyboard shortcut tied to a printable character
  must gate on input state, or it becomes a footgun.

- **`getInputValue` as a lazy accessor.** The router needed to read the composer's text without
  taking a ref into the TextareaRenderable. Pattern: pass `getInputValue?: () => string` as an
  optional option. Same shape as `services.workspace.cwd()` / `services.session.id()` — lazy,
  drift-aware, no subscription. This is the canonical shape for "read host state on demand from a
  consumer that doesn't own it."

- **Schema errors are not always your fault.** When the user hit
  `Invalid prompt: The messages do not match the ModelMessage[] schema` after `/auto`, the obvious
  hypothesis was my code. Tracing through `buildVisionUserMessages` (no false-positive in vision
  regex), `createToolModelOutput` (my `{success, output}` return wraps as a valid `type: "json"`
  tool-result), and the message-pipeline confirmed my code is clean. The failure was in
  `agent.messages` history — probably a leftover unmatched tool call from a previous cancelled
  turn. Fix: `/clear` and retry. Documented in the `/auto` usage hint so future runs surface the
  workaround in-place.

## Open / deferred

- **Auto mode currently has no UI for the structured status block.** The `auto_status` tool
  output is rendered as a normal tool result in the transcript. A future enhancement could be a
  dedicated `AutoStatusPanel` that renders blockers as an inline `TuiDialog` with action rows
  (continue / change-direction / abort) — would map cleanly onto the existing
  `payment-approval-panel.tsx` shape.

- **No checkpoint enforcement.** The seed prompt asks the model to checkpoint via `git commit`
  after each sub-goal, but the extension doesn't verify or enforce. A blocker-side enhancement:
  before declaring `state: done`, the extension could verify that the working tree is clean
  (no uncommitted changes) and reject the done-state if not.

- **No `auto_status` schema validation on the receiving side.** If the model emits malformed
  status (wrong enum value, missing required field), the zod schema rejects at the SDK boundary —
  but the user sees a generic tool-validation error. Could surface a friendlier "your model
  failed to emit a valid status block — try a different model" message.

- **The "Invalid prompt" error workaround is documented but not auto-recovered.** Future:
  detect schema-validation errors during dispatch and offer `/clear` as a one-click resume.

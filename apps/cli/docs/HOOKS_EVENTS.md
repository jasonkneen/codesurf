# Hook events — the contract

Events defined in `src/hooks/types.ts` fire to two audiences with identical
payloads: user-configured shell hooks (`src/hooks/index.ts`) and in-process
extension listeners (`services.events.subscribe`, backed by
`src/core/extensions/event-bus.ts`).

## Turn-lifecycle events — read this before subscribing

These three are routinely confused, and the confusion has produced real bugs
(a `/loop` that killed itself after one turn; voice capture cancelled on
every turn settle):

| Event | Fires when | It does NOT mean |
|---|---|---|
| `Stop` | A turn settles **successfully** — every time, including auto-dispatched turns | the user pressed stop |
| `StopFailure` | A turn settles with an error (API failure, max tool rounds, etc.) | the user pressed stop |
| `UserInterrupt` | The **human** interrupted in-flight work (Esc / stop button → `Agent.abort()` with something running) | the turn failed |

Rules of thumb:

- "Do something whenever the agent finishes responding" → `Stop`
  (examples: auto-mode stall detection, `/loop` continuation heartbeat,
  pet idle animation).
- "Halt because the user said so" → `UserInterrupt`
  (examples: `/loop` halt, voice recording cancellation).
- "React to a failed turn" → `StopFailure`.

A turn aborted by the user fires `UserInterrupt` (from `Agent.abort()`);
the aborted turn itself is discarded and fires neither `Stop` nor
`StopFailure`.

## Full event list

| Event | Trigger | Extra payload |
|---|---|---|
| `PreToolUse` | Before a tool executes (can block) | `tool_name`, `tool_input` |
| `PostToolUse` | After a tool succeeds | `tool_name`, `tool_input`, `tool_output` |
| `PostToolUseFailure` | After a tool fails | `tool_name`, `tool_input`, `error` |
| `UserPromptSubmit` | A new turn begins (incl. extension-dispatched prompts) | `user_prompt` |
| `SessionStart` | First turn of a session | `source`: startup / resume / clear |
| `SessionEnd` | Session teardown | — |
| `Stop` | Turn settled successfully | — |
| `StopFailure` | Turn settled with an error | `error` |
| `UserInterrupt` | Human interrupted in-flight work | — |
| `SubagentStart` / `SubagentStop` | Foreground sub-agent lifecycle | `agent_type`, `description` (+ `success`) |
| `TaskCreated` / `TaskCompleted` | Background delegation lifecycle | `agent_type`, `description` (+ `success`) |
| `PreCompact` / `PostCompact` | Context compaction | `trigger`: auto / manual |
| `Notification` | Background notification surfaced | `message` |
| `InstructionsLoaded` | Persona/instruction files loaded | `files_loaded` |
| `CwdChanged` | Working directory changed | `old_cwd`, `new_cwd` |

Every payload also carries `session_id` (when a session exists) and `cwd`.

Shell hooks match on the event name in `hooks` config; in-process listeners
subscribe with `api.services.events.subscribe(event, handler)` — handlers
run synchronously in registration order and must not throw (errors are
swallowed; schedule real work via `setTimeout`/microtask).

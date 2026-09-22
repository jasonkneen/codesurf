# Agent Kanban Contract

`Agent Kanban` is the canonical task-orchestration extension for CodeSurf.

It owns one task model and exposes two views over that same data:

- `board`
- `summary`

It also splits integration into two planes:

- MCP-style request/response tools for querying and mutating state
- bus events for live output, task-state transitions, and UI refresh

## Goals

- one task identity across board, summary, daemon popup, and reopen flows
- one recovery path for daemon-backed and terminal-backed work
- one extension that can ship as bundled or be installed/overridden like any other extension
- no duplicate task stores for summary widgets vs kanban boards

## Canonical Schema

The shared TypeScript contract lives in:

- `/Users/jkneen/clawd/collaborator-clone/src/shared/agentKanban.ts`

Primary records:

- `AgentKanbanTaskRecord`
- `AgentKanbanTaskStepRecord`
- `AgentKanbanBoardRecord`
- `AgentKanbanSummaryRecord`
- `AgentKanbanTaskOutputEvent`
- `AgentKanbanTaskStateEvent`

## Execution Model

Each task declares an execution target:

- `terminal`
- `local-daemon`
- `remote-daemon`

Each task also declares a run mode:

- `foreground`
- `background`

The execution adapter is responsible for:

- starting work
- stopping work
- sending additional input
- streaming output
- publishing state transitions
- persisting any daemon job or terminal linkage back onto the task record

## Task Hierarchy Rules

The board should track assigned work, not every low-level action.

That means:

- a user-assigned job from chat, the board, or a terminal is a top-level task
- a provider-native background agent or delegated daemon run may become a child task
- individual tool calls, retries, file edits, diffs, searches, and status lines are task steps, not peer tasks

Default policy:

- chat drawer list shows top-level tasks linked to that conversation
- terminal-linked views show the same top-level tasks linked to that terminal/session
- tool execution appears under the task as step/activity records
- only explicit delegation or detached execution promotes work into a child task

This keeps the board readable while still preserving detailed execution history.

## Linking Rules

Every task may carry one or more linkage references:

- `conversation`
- `terminal`
- `session`

These references are the bridge between:

- chat pull-out drawers
- terminal tiles
- daemon popup/status views
- board and summary widgets

Required behavior:

- reopening a task from any surface resolves through the same task id
- chat and terminal surfaces must publish linkage updates whenever a task attaches to a live session
- renderers must treat linkage as metadata on the canonical task record, not as separate local state

## MCP-Style Tool Surface

The extension control plane uses these tool names:

- `agent_kanban_get_board`
- `agent_kanban_get_summary`
- `agent_kanban_get_task`
- `agent_kanban_get_task_steps`
- `agent_kanban_create_task`
- `agent_kanban_update_task`
- `agent_kanban_move_task`
- `agent_kanban_archive_task`
- `agent_kanban_start_task`
- `agent_kanban_stop_task`
- `agent_kanban_send_input`
- `agent_kanban_get_output`
- `agent_kanban_open_task`
- `agent_kanban_link_task_session`
- `agent_kanban_append_task_step`

### Tool responsibilities

`agent_kanban_get_board`
- return the full board record for a board id or workspace context

`agent_kanban_get_summary`
- return the compact summary model used by the summary widget

`agent_kanban_get_task`
- return one task by id with live linkage metadata

`agent_kanban_get_task_steps`
- return the ordered step/activity stream for one task

`agent_kanban_create_task`
- create a task with prompt, execution config, tools, skills, refs, and placement

`agent_kanban_update_task`
- patch task metadata without changing execution state unless explicitly requested

`agent_kanban_move_task`
- move task between canonical columns

`agent_kanban_archive_task`
- archive a task into the archival column/state and clean up terminal/worktree/session state where appropriate

`agent_kanban_start_task`
- start execution through the selected adapter and return session linkage

`agent_kanban_stop_task`
- stop the active execution session

`agent_kanban_send_input`
- send more input into a running task session

`agent_kanban_get_output`
- return buffered output for a task, optionally since a sequence marker

`agent_kanban_open_task`
- return the UI target metadata needed to reopen/focus the task in a tile, session, or board

`agent_kanban_link_task_session`
- attach or update chat/terminal/session linkage on a canonical task record

`agent_kanban_append_task_step`
- append or update a step/activity record beneath an existing task

## Event Surface

The extension event plane uses these bus events:

- `agent-kanban:board-updated`
- `agent-kanban:summary-updated`
- `agent-kanban:task-created`
- `agent-kanban:task-updated`
- `agent-kanban:task-linked`
- `agent-kanban:task-moved`
- `agent-kanban:task-started`
- `agent-kanban:task-state`
- `agent-kanban:task-step`
- `agent-kanban:task-output`
- `agent-kanban:task-awaiting-input`
- `agent-kanban:task-completed`
- `agent-kanban:task-failed`
- `agent-kanban:task-archived`

### Event rules

- tools mutate/query state
- events announce change and stream progress
- events must be idempotent from the renderer’s point of view
- every task-output event carries a sequence number
- every task-state event carries the canonical task state and column
- every task-step event resolves against an existing task id
- task-linked events are the only supported way to bind chat sessions or terminals onto an existing task

## Chat and Terminal Bridge

The chat surface and terminal surface should not own their own task models.

Instead:

1. chat creates or resumes a canonical task when the user explicitly allocates work
2. chat publishes step records as tool calls and status changes stream in
3. terminal tiles attach to that task by publishing linkage metadata
4. terminal output contributes step/output records to the same task id
5. the board and summary widgets simply read the same task + step state

Implication:

- the chat pull-out drawer can show linked top-level tasks plus their recent steps
- the terminal can show the same task with live output and input affordances
- the board stays readable because it only promotes true delegated/background jobs to child tasks

## Column Semantics

Canonical columns:

- `backlog`
- `running`
- `review`
- `done`
- `failed`
- `archived`

Notes:

- `done` is user-facing completion
- `failed` is terminal/error state that still needs inspection
- `archived` replaces ad hoc trash behavior for persisted tasks

## UI Merge Rules

The current native React kanban contributes the richer task-authoring UI:

- tools
- skills and commands
- MCP servers
- hooks
- linked files
- linked tiles and groups
- inline terminal launch affordances

The current HTML `Agent Kanban` contributes the stronger execution lifecycle:

- managed sessions
- worktree lifecycle
- explicit start/stop/input/output handling
- review/trash flow

Merged product shape:

- native React UI remains the primary shell
- the extension backend owns execution/session orchestration
- `Summary` and `Board` are just two views over the same store
- chat drawers and terminal-linked views become additional views over the same task store

## Reopen and Recovery Rules

Every running or recently completed task must be reopenable through the same task id.

The task record must keep:

- daemon job id
- daemon sequence
- agent session id
- terminal tile id if applicable
- worktree path
- branch name if created

If Electron restarts:

- the extension reloads the board/task store
- active daemon-backed tasks are rehydrated from daemon state
- summary and board views both reflect the same recovered task state

## Bundled vs Optional

`Agent Kanban` should ship as a bundled extension, but remain optional.

That means:

- the app may provide it from `bundled-extensions/`
- users may disable it through normal extension controls
- user-installed or workspace-installed versions may override the bundled one by id

## Migration Notes

The existing built-in `kanban` tile and the existing `agent-kanban` extension should not both remain canonical.

Migration target:

1. converge on one `Agent Kanban` extension id
2. move execution/session logic behind this contract
3. make summary widget, daemon popup, and board read the same task store
4. retire duplicate popup-only task models

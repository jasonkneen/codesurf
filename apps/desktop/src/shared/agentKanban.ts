import type { ExecutionHostType } from './types'

export const AGENT_KANBAN_TOOL_NAMES = [
  'agent_kanban_get_board',
  'agent_kanban_get_summary',
  'agent_kanban_get_task',
  'agent_kanban_get_task_steps',
  'agent_kanban_create_task',
  'agent_kanban_update_task',
  'agent_kanban_move_task',
  'agent_kanban_archive_task',
  'agent_kanban_start_task',
  'agent_kanban_stop_task',
  'agent_kanban_send_input',
  'agent_kanban_get_output',
  'agent_kanban_open_task',
  'agent_kanban_link_task_session',
  'agent_kanban_append_task_step',
] as const

export type AgentKanbanToolName = typeof AGENT_KANBAN_TOOL_NAMES[number]

export const AGENT_KANBAN_EVENT_NAMES = [
  'agent-kanban:board-updated',
  'agent-kanban:summary-updated',
  'agent-kanban:task-created',
  'agent-kanban:task-updated',
  'agent-kanban:task-linked',
  'agent-kanban:task-moved',
  'agent-kanban:task-started',
  'agent-kanban:task-state',
  'agent-kanban:task-step',
  'agent-kanban:task-output',
  'agent-kanban:task-awaiting-input',
  'agent-kanban:task-completed',
  'agent-kanban:task-failed',
  'agent-kanban:task-archived',
] as const

export type AgentKanbanEventName = typeof AGENT_KANBAN_EVENT_NAMES[number]

export type AgentKanbanViewMode = 'board' | 'summary'
export type AgentKanbanExecutionBackend = 'terminal' | 'local-daemon' | 'remote-daemon'
export type AgentKanbanRunMode = 'foreground' | 'background'
export type AgentKanbanColumnId = 'backlog' | 'running' | 'review' | 'done' | 'failed' | 'archived'
export type AgentKanbanTaskSource = 'board' | 'chat' | 'terminal' | 'daemon' | 'mcp'
export type AgentKanbanTaskState =
  | 'idle'
  | 'queued'
  | 'running'
  | 'awaiting-input'
  | 'review'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'lost'

export interface AgentKanbanMcpServerRef {
  name: string
  url?: string | null
  cmd?: string | null
}

export interface AgentKanbanExecutionTarget {
  backend: AgentKanbanExecutionBackend
  hostType: Extract<ExecutionHostType, 'runtime' | 'local-daemon' | 'remote-daemon'>
  hostId: string | null
  runMode: AgentKanbanRunMode
}

export interface AgentKanbanSessionRef {
  terminalTileId?: string | null
  terminalSessionId?: string | null
  daemonJobId?: string | null
  daemonSequence?: number
  agentSessionId?: string | null
  worktreePath?: string | null
  branchName?: string | null
}

export interface AgentKanbanConversationRef {
  workspaceId?: string | null
  chatTileId?: string | null
  sessionId?: string | null
  messageId?: string | null
  queuedTurnId?: string | null
}

export interface AgentKanbanTerminalRef {
  tileId?: string | null
  sessionId?: string | null
  processLabel?: string | null
}

export type AgentKanbanTaskStepKind = 'tool' | 'subtask' | 'status' | 'input' | 'output' | 'note'
export type AgentKanbanTaskStepState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export interface AgentKanbanTaskStepRecord {
  id: string
  taskId: string
  parentStepId?: string | null
  kind: AgentKanbanTaskStepKind
  state: AgentKanbanTaskStepState
  title: string
  summary?: string | null
  toolName?: string | null
  provider?: string | null
  model?: string | null
  sessionId?: string | null
  sequence?: number | null
  startedAt?: string | null
  completedAt?: string | null
  updatedAt: string
}

export interface AgentKanbanTaskRecord {
  id: string
  title: string
  prompt: string
  description?: string
  instructions?: string
  workspaceId: string | null
  workspacePath: string | null
  projectPath: string | null
  columnId: AgentKanbanColumnId
  state: AgentKanbanTaskState
  source: AgentKanbanTaskSource
  parentTaskId?: string | null
  childTaskIds?: string[]
  agentId: string
  model?: string | null
  execution: AgentKanbanExecutionTarget
  tools: string[]
  skillsAndCommands: string[]
  mcpServers: AgentKanbanMcpServerRef[]
  hooks: string[]
  fileRefs: string[]
  taskRefs: string[]
  linkedTileIds: string[]
  linkedGroupId?: string | null
  latestOutput?: string | null
  latestError?: string | null
  summary?: string | null
  session: AgentKanbanSessionRef
  conversation?: AgentKanbanConversationRef | null
  terminal?: AgentKanbanTerminalRef | null
  stepCount?: number
  activeStepCount?: number
  createdAt: string
  updatedAt: string
  startedAt?: string | null
  completedAt?: string | null
}

export interface AgentKanbanBoardColumn {
  id: AgentKanbanColumnId
  label: string
  taskIds: string[]
}

export interface AgentKanbanBoardRecord {
  id: string
  title: string
  view: AgentKanbanViewMode
  workspaceId: string | null
  workspacePath: string | null
  columns: AgentKanbanBoardColumn[]
  tasks: AgentKanbanTaskRecord[]
  updatedAt: string
}

export interface AgentKanbanSummaryChecklistItem {
  id: string
  title: string
  done: boolean
}

export interface AgentKanbanSummaryRecord {
  boardId: string
  workspaceId: string | null
  workspacePath: string | null
  activeCount: number
  backgroundCount: number
  reviewCount: number
  failedCount: number
  completedCount: number
  checklist: AgentKanbanSummaryChecklistItem[]
  git: {
    staged: number
    unstaged: number
    untracked: number
    branch: string | null
  }
  sources: Array<{
    type: 'web' | 'mcp' | 'git' | 'files' | 'notes'
    label: string
  }>
  updatedAt: string
}

export interface AgentKanbanTaskOutputEvent {
  taskId: string
  line: string
  stream: 'stdout' | 'stderr' | 'system'
  sequence: number
  timestamp: string
}

export interface AgentKanbanTaskStateEvent {
  taskId: string
  columnId: AgentKanbanColumnId
  state: AgentKanbanTaskState
  summary?: string | null
  error?: string | null
  updatedAt: string
}

export interface AgentKanbanTaskLinkedEvent {
  taskId: string
  source: AgentKanbanTaskSource
  conversation?: AgentKanbanConversationRef | null
  terminal?: AgentKanbanTerminalRef | null
  session: AgentKanbanSessionRef
  updatedAt: string
}

export interface AgentKanbanTaskStepEvent {
  taskId: string
  step: AgentKanbanTaskStepRecord
}

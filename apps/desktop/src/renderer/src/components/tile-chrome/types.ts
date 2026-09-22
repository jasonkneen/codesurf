/**
 * Tile chrome drawer data types.
 */
import type { SkillConfig, ContextItem } from '../../../../shared/types'

export type { SkillConfig, ContextItem }

export interface TaskItem {
  id: string
  title: string
  status: 'pending' | 'in-progress' | 'done' | 'error' | 'paused'
  detail?: string
  timestamp: number
}

export interface ToolItem {
  id: string
  name: string
  status: 'running' | 'done' | 'error'
  input?: string
  output?: string
  elapsed?: number
  timestamp: number
}

export interface AvailableToolItem {
  id: string
  label: string
  source: 'builtin' | 'peer' | 'mcp-server'
  detail?: string
}

export interface MessageItem {
  id: string
  source: 'direct' | 'group'
  direction: 'inbound' | 'outbound'
  fromTileId: string
  toTileId?: string
  channel?: string
  subject: string
  type?: string
  kind?: string
  scope?: string
  createdAt: number
  status?: string
  mailbox?: string
}

export type DrawerTab = 'tasks' | 'tools' | 'skills' | 'context' | 'messages'

export interface DrawerData {
  tasks: TaskItem[]
  tools: ToolItem[]
  availableTools: AvailableToolItem[]
  skills: SkillConfig[]
  context: ContextItem[]
  messages: MessageItem[]
}

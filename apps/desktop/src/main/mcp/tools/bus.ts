import { bus } from '../../event-bus'
import type { McpToolContext, McpToolSchema } from '../types'
import { resolvePeerWorkspaceScope } from '../peer-scope.ts'

const workspaceProperty = {
  workspace_id: {
    type: 'string',
    description: 'Workspace ID (required for global-token callers)',
  },
}

export const BUS_TOOLS: McpToolSchema[] = [
  {
    name: 'update_progress',
    description: 'Report progress on a task. Any block subscribed to this channel will see the update.',
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceProperty,
        channel: { type: 'string', description: 'Channel to publish to (e.g. tile:abc123, task:xyz)' },
        status: { type: 'string', description: 'Current status text' },
        percent: { type: 'number', description: 'Progress 0-100 (optional)' },
        detail: { type: 'string', description: 'Additional detail (optional)' }
      },
      required: ['channel', 'status']
    }
  },
  {
    name: 'log_activity',
    description: 'Log an activity event. Appears in any subscribed activity feed or block indicator.',
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceProperty,
        channel: { type: 'string', description: 'Channel to publish to' },
        message: { type: 'string', description: 'Activity message' },
        level: { type: 'string', enum: ['info', 'warn', 'error', 'success'], description: 'Severity level' }
      },
      required: ['channel', 'message']
    }
  },
  {
    name: 'create_task',
    description: 'Create a new task visible to any subscribed task list or kanban.',
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceProperty,
        channel: { type: 'string', description: 'Channel to publish to' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] }
      },
      required: ['channel', 'title']
    }
  },
  {
    name: 'update_task',
    description: 'Update a task status.',
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceProperty,
        channel: { type: 'string' },
        task_id: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] },
        title: { type: 'string', description: 'Updated title (optional)' },
        detail: { type: 'string', description: 'Status detail (optional)' }
      },
      required: ['channel', 'task_id', 'status']
    }
  },
  {
    name: 'notify',
    description: 'Send a notification to the canvas operator.',
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceProperty,
        channel: { type: 'string' },
        title: { type: 'string' },
        message: { type: 'string' },
        level: { type: 'string', enum: ['info', 'warn', 'error', 'success'] }
      },
      required: ['channel', 'message']
    }
  },
]

const BUS_TOOL_NAMES = new Set(BUS_TOOLS.map(tool => tool.name))

export function scopeBusChannel(workspaceId: string, requested: unknown): string | null {
  if (typeof requested !== 'string' || !requested.trim()) return null
  const channel = requested.trim()
  const tileMatch = /^tile:([^:]+)(?::(.+))?$/.exec(channel)
  if (tileMatch) {
    if (tileMatch[2]) {
      return tileMatch[1] === workspaceId ? channel : null
    }
    return `tile:${workspaceId}:${tileMatch[1]}`
  }
  if (channel.startsWith('workspace:')) {
    return channel.startsWith(`workspace:${workspaceId}:`) ? channel : null
  }
  return `workspace:${workspaceId}:${channel}`
}

export async function handleBusTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpToolContext,
): Promise<string | null> {
  if (!BUS_TOOL_NAMES.has(name)) return null

  const { sendToRenderer } = ctx
  const scope = resolvePeerWorkspaceScope(ctx.principal, args.workspace_id)
  if (!scope.ok) return scope.error
  const channel = scopeBusChannel(scope.workspaceId, args.channel)
  if (!channel) return 'Forbidden: invalid or cross-workspace channel'
  const publish = (
    type: 'progress' | 'activity' | 'task' | 'notification',
    payload: Record<string, unknown>,
  ) => {
    const evt = bus.publish({
      channel,
      type,
      source: 'mcp',
      payload: { ...payload, workspaceId: scope.workspaceId },
    })
    sendToRenderer('bus:event', evt)
    return evt
  }

  if (name === 'update_progress') {
    publish('progress', { status: args.status, percent: args.percent, detail: args.detail })
    return `Progress updated on ${channel}: ${args.status}`
  }

  if (name === 'log_activity') {
    publish('activity', { message: args.message, level: args.level ?? 'info' })
    return `Activity logged on ${channel}: ${args.message}`
  }

  if (name === 'create_task') {
    publish('task', { title: args.title, description: args.description, status: args.status ?? 'pending', action: 'create' })
    return `Task created on ${channel}: ${args.title}`
  }

  if (name === 'update_task') {
    publish('task', { task_id: args.task_id, status: args.status, title: args.title, detail: args.detail, action: 'update' })
    return `Task ${args.task_id} updated on ${channel}: ${args.status}`
  }

  if (name === 'notify') {
    publish('notification', { title: args.title, message: args.message, level: args.level ?? 'info' })
    return `Notification sent on ${channel}: ${args.message}`
  }

  return null
}

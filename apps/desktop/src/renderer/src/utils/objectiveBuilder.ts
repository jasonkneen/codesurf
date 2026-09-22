import type { ActivityStatus, SkillConfig, ContextItem } from '../../../shared/types'

interface TaskEntry {
  id: string
  title: string
  status: ActivityStatus
}

export interface ObjectiveOpts {
  tileId: string
  title?: string
  tasks: TaskEntry[]
  skills: SkillConfig[]
  context: ContextItem[]
}

function statusMark(s: ActivityStatus): string {
  switch (s) {
    case 'done': return '[x]'
    case 'running': return '[~]'
    case 'paused': return '[||]'
    case 'error': return '[!]'
    default: return '[ ]'
  }
}

export function buildObjective(opts: ObjectiveOpts): string {
  const { tileId, title, tasks, skills, context } = opts
  const lines: string[] = []

  // Header
  lines.push(`# Objective${title ? `: ${title}` : ''}`)
  lines.push('')

  // Tasks
  if (tasks.length > 0) {
    lines.push('## Tasks')
    for (const t of tasks) {
      lines.push(`- ${statusMark(t.status)} ${t.title} (${t.status})`)
    }
    lines.push('')
  }

  // Context
  const notes = context.filter(c => c.type === 'note')
  const files = context.filter(c => c.type === 'file')

  if (notes.length > 0 || files.length > 0) {
    lines.push('## Context')
    for (const n of notes) {
      if (n.content) lines.push(n.content)
    }
    if (files.length > 0) {
      lines.push('')
      lines.push(`Referenced files: ${files.map(f => f.name).join(', ')}`)
    }
    lines.push('')
  }

  // Skills / Tools
  const enabled = skills.filter(s => s.enabled)
  if (enabled.length > 0) {
    lines.push('## Available Skills & Tools')
    for (const s of enabled) {
      const src = s.server ? ` (${s.server})` : ''
      lines.push(`- @${s.id}${src} — ${s.description ?? 'enabled'}`)
    }
    lines.push('')
  }

  // Communication protocol
  lines.push('## Communication Protocol')
  lines.push('Use these MCP tools to report progress:')
  lines.push('')
  lines.push('| Tool | When |')
  lines.push('|------|------|')
  lines.push('| update_task(channel, task_id, status) | Update task status |')
  lines.push('| create_task(channel, title) | Create a new task |')
  lines.push('| reload_objective(tile_id) | Get latest objective |')
  lines.push('| pause_task(channel, task_id, reason) | Pause a task |')
  lines.push('| get_context(tile_id) | Read context files |')
  lines.push('| notify(channel, message) | Send notification |')
  lines.push('')
  lines.push(`Your tile channel: tile:${tileId}`)
  lines.push('')

  // Rules
  lines.push('## Rules')
  lines.push('1. Re-read this file when you receive a reload signal')
  lines.push('2. Update task status via MCP tools as you work')
  lines.push('3. Call notify when you need human attention')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)

  return lines.join('\n')
}

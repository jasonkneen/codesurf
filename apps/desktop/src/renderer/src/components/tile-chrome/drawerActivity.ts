/**
 * Tile chrome drawer activity persistence + bus event processing.
 */
import {
  ACTIVITY_LIMITS,
  type ActivityMetadata,
  type ActivityUpsertInput,
  type SkillConfig,
} from '../../../../shared/types.ts'
import { hasCapability } from '../../platform/capabilities.ts'
import type { AvailableToolItem, DrawerData } from './types'
import type React from 'react'

// ─── Activity store persistence ─────────────────────────────────────────────

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g
const TEXT_ENCODER = new TextEncoder()
const MAX_DRAWER_METADATA_BYTES = 2048
const MAX_DRAWER_METADATA_STRING = 256
const DRAWER_METADATA_KEYS = [
  'action',
  'status',
  'name',
  'tool',
  'path',
  'file',
  'source',
  'task_id',
  'tool_id',
  'file_id',
  'elapsed',
] as const

export interface ActivityClientHealthSignal {
  source: 'renderer'
  operation: 'upsert'
  code: 'unavailable' | 'write_failed'
  occurredAt: number
}

export function createActivityHealthReporter(options: {
  intervalMs?: number
  now?: () => number
  emit: (signal: ActivityClientHealthSignal) => void
}): (code: ActivityClientHealthSignal['code']) => void {
  const intervalMs = options.intervalMs ?? 30_000
  const now = options.now ?? Date.now
  const lastEmitted = new Map<string, number>()
  return code => {
    const occurredAt = now()
    const previous = lastEmitted.get(code)
    if (previous !== undefined && occurredAt - previous < intervalMs) return
    lastEmitted.set(code, occurredAt)
    options.emit({ source: 'renderer', operation: 'upsert', code, occurredAt })
  }
}

const reportActivityHealth = createActivityHealthReporter({
  emit(signal) {
    try {
      window.dispatchEvent(new CustomEvent('codesurf:activity-health', { detail: signal }))
    } catch {
      // Health reporting must not interfere with tile event rendering.
    }
  },
})

function boundedText(value: unknown, fallback: string, maxLength: number): string {
  const text = (
    typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : typeof value === 'boolean'
          ? String(value)
          : fallback
  )
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (text || fallback).slice(0, maxLength)
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = boundedText(value, '', maxLength)
  return text || undefined
}

function identifier(value: unknown, fallback: unknown): string {
  const normalized = boundedText(value, boundedText(fallback, 'activity', ACTIVITY_LIMITS.id), ACTIVITY_LIMITS.id)
  return normalized === '.' || normalized === '..' ? `activity-${normalized.length}` : normalized
}

function metadataValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return boundedText(value, '', MAX_DRAWER_METADATA_STRING)
  return undefined
}

export function projectActivityMetadata(
  eventType: string,
  payload: Record<string, unknown>,
): ActivityMetadata {
  const metadata: ActivityMetadata = {
    event_type: boundedText(eventType, 'unknown', 64),
  }
  if (payload.error !== undefined) metadata.has_error = Boolean(payload.error)
  for (const key of DRAWER_METADATA_KEYS) {
    const value = metadataValue(payload[key])
    if (value === undefined) continue
    const candidate = { ...metadata, [key]: value }
    if (TEXT_ENCODER.encode(JSON.stringify(candidate)).byteLength > MAX_DRAWER_METADATA_BYTES) break
    metadata[key] = value
  }
  return metadata
}

function toolInputDetail(input: unknown): string | undefined {
  if (typeof input === 'string') return optionalText(input, 200)
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const value = input as Record<string, unknown>
  return optionalText(
    value.path ?? value.command ?? value.query ?? value.name,
    200,
  )
}

export function buildActivityUpsert(
  tileIdValue: unknown,
  evt: { type: string, payload: Record<string, unknown>, id: string },
): ActivityUpsertInput | null {
  const p = evt.payload
  const tileId = identifier(tileIdValue, 'tile')
  const metadata = projectActivityMetadata(evt.type, p)

  if (evt.type === 'task') {
    const detail = optionalText(p.detail, ACTIVITY_LIMITS.detail)
    return {
      id: identifier(p.task_id ?? p.id, evt.id),
      tileId,
      type: 'task',
      status: p.status === 'done' ? 'done' : p.status === 'error' ? 'error' : p.status === 'in-progress' ? 'running' : 'pending',
      title: boundedText(p.title, 'Untitled task', ACTIVITY_LIMITS.title),
      ...(detail ? { detail } : {}),
      metadata,
    }
  }

  if (evt.type === 'tool_start' || evt.type === 'tool') {
    const detail = toolInputDetail(p.input)
    return {
      id: identifier(p.tool_id ?? p.id, evt.id),
      tileId,
      type: 'tool',
      status: evt.type === 'tool_start' ? 'running' : (p.error ? 'error' : 'done'),
      title: boundedText(p.name ?? p.tool, 'Unknown tool', ACTIVITY_LIMITS.title),
      ...(detail ? { detail } : {}),
      metadata,
    }
  }

  if (evt.type === 'file' || evt.type === 'file_activity') {
    const detail = optionalText(p.action, ACTIVITY_LIMITS.detail)
    return {
      id: identifier(p.file_id, evt.id),
      tileId,
      type: 'skill',
      status: 'done',
      title: boundedText(p.path ?? p.file, 'unknown', ACTIVITY_LIMITS.title),
      ...(detail ? { detail } : {}),
      metadata,
    }
  }

  if (evt.type === 'note' || evt.type === 'notification' || evt.type === 'progress') {
    return {
      id: identifier(evt.id, `${evt.type}-activity`),
      tileId,
      type: 'context',
      status: 'done',
      title: boundedText(
        p.message ?? p.text ?? p.title ?? p.status,
        'Activity update',
        ACTIVITY_LIMITS.title,
      ),
      detail: boundedText(p.source, evt.type, ACTIVITY_LIMITS.detail),
      metadata,
    }
  }

  return null
}

export function persistToActivityStore(
  workspaceId: string | undefined,
  tileId: string,
  evt: { type: string; payload: Record<string, unknown>; id: string },
): void {
  if (!workspaceId) return
  if (!window.electron?.activity || !hasCapability('activity')) {
    reportActivityHealth('unavailable')
    return
  }
  const data = buildActivityUpsert(tileId, evt)
  if (!data) return
  try {
    void window.electron.activity.upsert(workspaceId, data)
      .catch(() => reportActivityHealth('write_failed'))
  } catch {
    reportActivityHealth('write_failed')
  }
}

// ─── Event processing helpers ────────────────────────────────────────────────

export function processEvent(evt: { type: string; payload: Record<string, unknown>; id: string; timestamp: number }, setData: React.Dispatch<React.SetStateAction<DrawerData>>): void {
  const p = evt.payload as any

  if (evt.type === 'task') {
    if (p?.action === 'create' || (!p?.action && p?.title)) {
      setData(prev => {
        if (prev.tasks.some(t => t.id === (p.task_id ?? p.id))) return prev
        return { ...prev, tasks: [...prev.tasks, {
          id: p.task_id ?? p.id ?? evt.id,
          title: p.title ?? 'Untitled task',
          status: p.status ?? 'pending',
          detail: p.detail,
          timestamp: evt.timestamp,
        }]}
      })
    } else if (p?.action === 'update' && p?.task_id) {
      setData(prev => ({ ...prev, tasks: prev.tasks.map(t =>
        t.id === p.task_id
          ? { ...t, status: p.status ?? t.status, title: p.title ?? t.title, detail: p.detail ?? t.detail }
          : t
      )}))
    }
  }

  if (evt.type === 'tool_start' || evt.type === 'tool') {
    setData(prev => {
      const toolId = p?.tool_id ?? p?.id ?? evt.id
      if (evt.type === 'tool_start') {
        if (prev.tools.some(t => t.id === toolId)) return prev
        return { ...prev, tools: [...prev.tools, {
          id: toolId,
          name: p?.name ?? p?.tool ?? 'Unknown tool',
          status: 'running',
          input: typeof p?.input === 'string' ? p.input.slice(0, 120) : undefined,
          timestamp: evt.timestamp,
        }]}
      }
      // tool complete/update
      return { ...prev, tools: prev.tools.map(t =>
        t.id === toolId
          ? { ...t, status: p?.error ? 'error' : 'done', output: p?.output?.toString()?.slice(0, 120), elapsed: p?.elapsed }
          : t
      )}
    })
  }

  if (evt.type === 'tool_inventory') {
    const incoming = Array.isArray(p?.tools) ? p.tools : []
    const nextTools: AvailableToolItem[] = incoming
      .filter((tool): tool is Record<string, unknown> => typeof tool === 'object' && tool !== null)
      .map((tool, index) => {
        const source = tool.source === 'peer' || tool.source === 'mcp-server' ? tool.source : 'builtin'
        const label = typeof tool.label === 'string' ? tool.label : typeof tool.name === 'string' ? tool.name : `Tool ${index + 1}`
        return {
          id: typeof tool.id === 'string' ? tool.id : `${source}:${label}`,
          label,
          source,
          detail: typeof tool.detail === 'string' ? tool.detail : undefined,
        }
      })

    setData(prev => ({ ...prev, availableTools: nextTools }))
  }

  if (evt.type === 'skill_inventory') {
    const incoming = Array.isArray(p?.skills) ? p.skills : []
    const nextSkills: SkillConfig[] = incoming
      .filter((skill): skill is Record<string, unknown> => typeof skill === 'object' && skill !== null)
      .map((skill, index) => {
        const source = skill.source === 'mcp' || skill.source === 'workspace' || skill.source === 'command'
          ? skill.source
          : 'builtin'
        const name = typeof skill.name === 'string' ? skill.name : `Skill ${index + 1}`
        return {
          id: typeof skill.id === 'string' ? skill.id : `${source}:${name}`,
          name,
          enabled: skill.enabled !== false,
          source,
          server: typeof skill.server === 'string' ? skill.server : undefined,
          description: typeof skill.description === 'string' ? skill.description : undefined,
        }
      })

    setData(prev => ({ ...prev, skills: nextSkills }))
  }

  // Skills and context are managed interactively via the drawer, not from bus events.
  // Bus events for files/notes are persisted to the activity store but don't populate the drawer.
}

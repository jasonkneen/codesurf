import type { BusEventType } from './types.ts'

const CORE_BUS_EVENT_TYPES = new Set<BusEventType>([
  'progress',
  'activity',
  'task',
  'notification',
  'ask',
  'answer',
  'data',
  'system',
  'tool_inventory',
  'skill_inventory',
  'tool_start',
  'tool',
  'file',
  'file_activity',
  'note',
  'browser.evidence.snapshot',
  'browser.page_health',
  'browser.evidence',
])

const DOMAIN_BUS_EVENT_TYPE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/

export function isSafeBusEventType(type: string): type is BusEventType {
  const safe = String(type ?? '').trim()
  if (!safe || safe.length > 160) return false
  if (CORE_BUS_EVENT_TYPES.has(safe as BusEventType)) return true
  return DOMAIN_BUS_EVENT_TYPE.test(safe)
}

export function coerceBusEventType(type: string | undefined): BusEventType {
  const safe = String(type ?? '').trim()
  return isSafeBusEventType(safe) ? safe : 'data'
}
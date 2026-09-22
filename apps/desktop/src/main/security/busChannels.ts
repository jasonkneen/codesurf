import { isSafeBusEventType as isSharedSafeBusEventType } from '../../shared/busEventTypes.ts'
import type { BusEventType } from '../../shared/types.ts'

const MAX_LEN = 160
const SAFE_TOKEN = /^[a-zA-Z0-9:_*-]+$/

export function assertSafeBusToken(value: string, label: string): string {
  const token = String(value ?? '').trim()
  if (!token || token.length > MAX_LEN) throw new Error(`Invalid ${label}`)
  if (!SAFE_TOKEN.test(token)) throw new Error(`Invalid ${label}`)
  if (token.includes('..')) throw new Error(`Invalid ${label}`)
  return token
}

export function assertSafeBusChannel(channel: string, options?: { allowWildcard?: boolean }): string {
  const safe = assertSafeBusToken(channel, 'bus channel')
  if (!options?.allowWildcard && safe.includes('*')) {
    throw new Error('Wildcards are not allowed in bus publish channels')
  }
  return safe
}

export function isSafeBusEventType(type: string): type is BusEventType {
  return isSharedSafeBusEventType(type)
}

export function assertSafeBusEventType(type: string): BusEventType {
  const safe = String(type ?? '').trim()
  if (!isSharedSafeBusEventType(safe)) throw new Error('Invalid bus event type')
  return safe as BusEventType
}

function extractScopedIdentity(source: string): {
  workspaceId: string | null
  scopedId: string
} | null {
  const match = source.match(
    /^(?:browser|terminal|chat|tile|extension|kanban|image):([^:*]+)(?::([^:*]+))?$/,
  )
  if (!match) return null
  return match[2]
    ? { workspaceId: match[1], scopedId: match[2] }
    : { workspaceId: null, scopedId: match[1] }
}

function channelMatchesSourceScope(channel: string, source: string): boolean {
  const identity = extractScopedIdentity(source)
  if (!identity) return true
  const { workspaceId, scopedId } = identity

  const allowed = new Set(
    ['tile', 'ctx', 'card', 'browser', 'terminal', 'chat', 'kanban', 'image']
      .map(prefix => workspaceId
        ? `${prefix}:${workspaceId}:${scopedId}`
        : `${prefix}:${scopedId}`),
  )

  if (allowed.has(channel)) return true

  for (const prefix of allowed) {
    if (channel.startsWith(`${prefix}:`)) return true
  }

  return false
}

export function assertBusPublishAllowed(channel: string, source: string, type: string): {
  channel: string
  source: string
  type: BusEventType
} {
  return {
    channel: assertSafeBusChannel(channel),
    source: assertSafeBusToken(source, 'bus source'),
    type: assertSafeBusEventType(type),
  }
}

export function assertBusPublishScope(channel: string, source: string): void {
  if (!channelMatchesSourceScope(channel, source)) {
    throw new Error('Bus publish channel is outside source scope')
  }
}

export function assertBusSubscribeAllowed(channel: string, subscriberId: string): {
  channel: string
  subscriberId: string
} {
  return {
    channel: assertSafeBusChannel(channel, { allowWildcard: true }),
    subscriberId: assertSafeBusToken(subscriberId, 'bus subscriber'),
  }
}

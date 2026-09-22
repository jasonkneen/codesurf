import type {
  RelayChannelMessageDraft,
  RelayDirectMessageDraft,
  RelayMessageKind,
  RelayPriority,
  RelaySpawnRequest,
  RelayWorkContext,
} from '../../../packages/codesurf-relay/src'

const MESSAGE_KINDS = new Set<RelayMessageKind>([
  'request',
  'reply',
  'update',
  'handoff',
  'alert',
  'memory',
  'channel',
  'system',
])
const PRIORITIES = new Set<RelayPriority>([
  'low',
  'normal',
  'high',
  'critical',
])
const PROVIDERS = new Set<NonNullable<RelaySpawnRequest['provider']>>([
  'claude',
  'codex',
  'opencode',
  'openclaw',
  'hermes',
  'unknown',
])

export const RELAY_IPC_LIMITS = {
  idBytes: 128,
  nameBytes: 256,
  taskBytes: 32 * 1024,
  subjectBytes: 1024,
  bodyBytes: 64 * 1024,
  shortTextBytes: 1024,
  pathBytes: 4096,
  listItems: 128,
  channelItems: 64,
  requestBytes: 128 * 1024,
  structuredBytes: 64 * 1024,
  structuredDepth: 8,
  structuredEntries: 1024,
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isBoundedString(
  value: unknown,
  maxBytes: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === 'string'
    && (allowEmpty || value.trim().length > 0)
    && Buffer.byteLength(value, 'utf8') <= maxBytes
  )
}

function isOptionalBoundedString(
  value: unknown,
  maxBytes: number,
): value is string | undefined {
  return value === undefined || isBoundedString(value, maxBytes, true)
}

function isBoundedStringList(
  value: unknown,
  maxItems: number,
  maxItemBytes: number,
  allowEmpty = false,
): value is string[] {
  return (
    Array.isArray(value)
    && value.length <= maxItems
    && value.every(item => isBoundedString(
      item,
      maxItemBytes,
      allowEmpty,
    ))
  )
}

function isBoundedStructuredValue(
  value: unknown,
  maxBytes = RELAY_IPC_LIMITS.structuredBytes,
): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{
    value,
    depth: 0,
  }]
  const seen = new Set<object>()
  let bytes = 0
  let entries = 0

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.value === null || current.value === undefined) {
      bytes += 4
    } else if (typeof current.value === 'string') {
      bytes += Buffer.byteLength(current.value, 'utf8')
    } else if (
      typeof current.value === 'number'
      && Number.isFinite(current.value)
    ) {
      bytes += 8
    } else if (typeof current.value === 'boolean') {
      bytes += 5
    } else if (
      Array.isArray(current.value)
      || isRecord(current.value)
    ) {
      if (current.depth >= RELAY_IPC_LIMITS.structuredDepth) return false
      if (seen.has(current.value)) return false
      seen.add(current.value)
      if (Array.isArray(current.value)) {
        entries += current.value.length
        for (const item of current.value) {
          stack.push({ value: item, depth: current.depth + 1 })
        }
      } else {
        const pairs = Object.entries(current.value)
        entries += pairs.length
        for (const [key, item] of pairs) {
          bytes += Buffer.byteLength(key, 'utf8')
          stack.push({ value: item, depth: current.depth + 1 })
        }
      }
    } else {
      return false
    }
    if (
      bytes > maxBytes
      || entries > RELAY_IPC_LIMITS.structuredEntries
    ) {
      return false
    }
  }
  try {
    const serialized = JSON.stringify(value)
    return (
      serialized !== undefined
      && Buffer.byteLength(serialized, 'utf8') <= maxBytes
    )
  } catch {
    return false
  }
}

function isBoundedRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isBoundedStructuredValue(value)
}

function hasValidMessageFields(value: Record<string, unknown>): boolean {
  return (
    isBoundedString(value.subject, RELAY_IPC_LIMITS.subjectBytes)
    && isBoundedString(value.body, RELAY_IPC_LIMITS.bodyBytes)
    && isOptionalBoundedString(value.threadId, RELAY_IPC_LIMITS.idBytes)
    && isOptionalBoundedString(value.replyToId, RELAY_IPC_LIMITS.idBytes)
    && (
      value.kind === undefined
      || (
        typeof value.kind === 'string'
        && MESSAGE_KINDS.has(value.kind as RelayMessageKind)
      )
    )
    && (
      value.priority === undefined
      || (
        typeof value.priority === 'string'
        && PRIORITIES.has(value.priority as RelayPriority)
      )
    )
    && (value.data === undefined || isBoundedRecord(value.data))
  )
}

export function isRelayDirectMessageDraft(
  value: unknown,
): value is RelayDirectMessageDraft {
  return (
    isRecord(value)
    && isBoundedStructuredValue(value, RELAY_IPC_LIMITS.requestBytes)
    && isBoundedString(value.to, RELAY_IPC_LIMITS.idBytes)
    && hasValidMessageFields(value)
  )
}

export function isRelayChannelMessageDraft(
  value: unknown,
): value is RelayChannelMessageDraft {
  return (
    isRecord(value)
    && isBoundedStructuredValue(value, RELAY_IPC_LIMITS.requestBytes)
    && isBoundedString(value.channel, RELAY_IPC_LIMITS.idBytes)
    && hasValidMessageFields(value)
  )
}

export function isRelaySpawnRequest(
  value: unknown,
): value is RelaySpawnRequest {
  if (
    !isRecord(value)
    || !isBoundedStructuredValue(value, RELAY_IPC_LIMITS.requestBytes)
  ) return false
  return (
    isBoundedString(value.name, RELAY_IPC_LIMITS.nameBytes)
    && isBoundedString(value.task, RELAY_IPC_LIMITS.taskBytes)
    && isOptionalBoundedString(value.id, RELAY_IPC_LIMITS.idBytes)
    && isOptionalBoundedString(value.tileId, RELAY_IPC_LIMITS.idBytes)
    && isOptionalBoundedString(value.model, RELAY_IPC_LIMITS.shortTextBytes)
    && isOptionalBoundedString(value.mode, RELAY_IPC_LIMITS.shortTextBytes)
    && isOptionalBoundedString(value.thinking, RELAY_IPC_LIMITS.shortTextBytes)
    && (
      value.provider === undefined
      || (
        typeof value.provider === 'string'
        && PROVIDERS.has(value.provider as NonNullable<RelaySpawnRequest['provider']>)
      )
    )
    && (
      value.channels === undefined
      || isBoundedStringList(
        value.channels,
        RELAY_IPC_LIMITS.channelItems,
        RELAY_IPC_LIMITS.idBytes,
      )
    )
    && (value.metadata === undefined || isBoundedRecord(value.metadata))
    && (
      value.timeoutMs === undefined
      || (
        Number.isSafeInteger(value.timeoutMs)
        && (value.timeoutMs as number) > 0
      )
    )
  )
}

export function isRelayWorkContext(
  value: unknown,
): value is RelayWorkContext {
  if (
    !isRecord(value)
    || !isBoundedString(value.summary, RELAY_IPC_LIMITS.taskBytes)
    || !isBoundedStructuredValue(value, RELAY_IPC_LIMITS.requestBytes)
  ) return false
  return (
    isOptionalBoundedString(value.branch, RELAY_IPC_LIMITS.pathBytes)
    && isOptionalBoundedString(value.worktreePath, RELAY_IPC_LIMITS.pathBytes)
    && isOptionalBoundedString(
      value.updatedAt,
      RELAY_IPC_LIMITS.shortTextBytes,
    )
    && (
      value.updatedTs === undefined
      || (
        Number.isSafeInteger(value.updatedTs)
        && (value.updatedTs as number) >= 0
      )
    )
    && (
      value.files === undefined
      || isBoundedStringList(
        value.files,
        RELAY_IPC_LIMITS.listItems,
        RELAY_IPC_LIMITS.pathBytes,
        true,
      )
    )
    && (
      value.topics === undefined
      || isBoundedStringList(
        value.topics,
        RELAY_IPC_LIMITS.listItems,
        RELAY_IPC_LIMITS.shortTextBytes,
        true,
      )
    )
    && (
      value.collaborators === undefined
      || isBoundedStringList(
        value.collaborators,
        RELAY_IPC_LIMITS.listItems,
        RELAY_IPC_LIMITS.idBytes,
        true,
      )
    )
    && (
      value.blockers === undefined
      || isBoundedStringList(
        value.blockers,
        RELAY_IPC_LIMITS.listItems,
        RELAY_IPC_LIMITS.pathBytes,
        true,
      )
    )
    && (
      value.impacts === undefined
      || (
        Array.isArray(value.impacts)
        && value.impacts.length <= RELAY_IPC_LIMITS.listItems
        && value.impacts.every(impact => (
          isRecord(impact)
          && (
            impact.targetType === 'agent'
            || impact.targetType === 'human'
            || impact.targetType === 'system'
          )
          && isOptionalBoundedString(
            impact.targetId,
            RELAY_IPC_LIMITS.idBytes,
          )
          && isBoundedString(
            impact.description,
            RELAY_IPC_LIMITS.pathBytes,
          )
          && (
            impact.severity === 'low'
            || impact.severity === 'medium'
            || impact.severity === 'high'
          )
        ))
      )
    )
  )
}

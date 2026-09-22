import type {
  AgentRoom,
  RoomEvent,
  RoomMember,
  RoomSnapshot,
} from './types.ts'
import {
  MAX_PROJECTED_EVENT_METADATA_BYTES,
  MAX_PROJECTED_EVENT_TARGETS,
  MAX_PROJECTED_EVENT_TEXT_BYTES,
  MAX_PROJECTED_MEMBER_FILES,
  MAX_PROJECTED_MEMBER_FILE_BYTES,
  MAX_PROJECTED_MEMBER_TASK_BYTES,
  fitsSerializedBudget,
  serializedMetrics,
  truncateUtf8,
  type SerializedBudget,
} from './validation.ts'

export interface ProjectionResult<T> {
  values: T[]
  omitted: number
  fieldsTruncated: number
}

function compactMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined
  const metrics = serializedMetrics(metadata)
  if (metrics && metrics.bytes <= MAX_PROJECTED_EVENT_METADATA_BYTES) {
    return structuredClone(metadata)
  }
  return { __codesurfTruncated: '[truncated: event metadata omitted from projection]' }
}

export function projectMember(member: RoomMember): RoomMember {
  const task = truncateUtf8(member.task, MAX_PROJECTED_MEMBER_TASK_BYTES)
  const retainedFiles = member.files
    .slice(0, MAX_PROJECTED_MEMBER_FILES)
    .map(file => truncateUtf8(file, MAX_PROJECTED_MEMBER_FILE_BYTES))
  const taskTruncated = task !== member.task
  const filesOmitted = Math.max(0, member.files.length - retainedFiles.length)
  const fileFieldsTruncated = retainedFiles.reduce(
    (count, file, index) => count + (file !== member.files[index] ? 1 : 0),
    0,
  )
  return {
    ...member,
    task,
    files: retainedFiles,
    ...(taskTruncated || filesOmitted > 0 || fileFieldsTruncated > 0
      ? { truncation: { task: taskTruncated, filesOmitted, fileFieldsTruncated } }
      : {}),
  }
}

export function projectEvent(event: RoomEvent): RoomEvent {
  return {
    ...event,
    text: truncateUtf8(event.text, MAX_PROJECTED_EVENT_TEXT_BYTES),
    targetTileIds: event.targetTileIds.slice(0, MAX_PROJECTED_EVENT_TARGETS),
    meta: compactMetadata(event.meta),
  }
}

export function projectEvents(
  events: RoomEvent[],
  budget: SerializedBudget,
): ProjectionResult<RoomEvent> {
  const values: RoomEvent[] = []
  const truncatedFieldsByValue: number[] = []
  let fieldsTruncated = 0
  let omitted = events.length
  let usedBytes = 256
  let usedTokens = 64

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const projected = projectEvent(events[index]!)
    const projectedFieldCount = (
      projected.text !== events[index]!.text
      || projected.targetTileIds.length !== events[index]!.targetTileIds.length
      || JSON.stringify(projected.meta) !== JSON.stringify(events[index]!.meta)
    ) ? 1 : 0
    const metrics = serializedMetrics(projected)
    if (
      !metrics
      || usedBytes + metrics.bytes + 1 > budget.maxBytes
      || usedTokens + metrics.estimatedTokens > budget.maxEstimatedTokens
    ) break
    values.unshift(projected)
    truncatedFieldsByValue.unshift(projectedFieldCount)
    omitted = index
    fieldsTruncated += projectedFieldCount
    usedBytes += metrics.bytes + 1
    usedTokens += metrics.estimatedTokens
  }
  while (!fitsSerializedBudget({
    values,
    truncation: {
      eventsOmitted: omitted,
      eventFieldsTruncated: fieldsTruncated,
    },
  }, budget)) {
    if (values.length === 0) break
    values.shift()
    fieldsTruncated -= truncatedFieldsByValue.shift() ?? 0
    omitted += 1
  }

  return { values, omitted, fieldsTruncated }
}

export function projectRoomSnapshot(
  room: AgentRoom,
  budget: SerializedBudget,
): RoomSnapshot {
  const members: RoomMember[] = []
  let memberFieldsTruncated = 0
  const sortedMembers = [...room.members.values()]
    .sort((a, b) => a.tileId.localeCompare(b.tileId))
  const baseMetrics = serializedMetrics({
    id: room.id,
    workspaceId: room.workspaceId,
    memberKey: room.memberKey,
    members: [],
    eventCount: room.events.length,
    latestSequence: Math.max(0, room.nextSequence - 1),
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    truncation: {
      membersOmitted: sortedMembers.length,
      memberFieldsTruncated: 0,
    },
  })
  let usedBytes = baseMetrics?.bytes ?? budget.maxBytes
  let usedTokens = baseMetrics?.estimatedTokens ?? budget.maxEstimatedTokens

  for (const member of sortedMembers) {
    const projected = projectMember(member)
    const projectedFieldCount = projected.truncation ? 1 : 0
    const metrics = serializedMetrics(projected)
    if (
      !metrics
      || usedBytes + metrics.bytes + 1 > budget.maxBytes
      || usedTokens + metrics.estimatedTokens > budget.maxEstimatedTokens
    ) break
    members.push(projected)
    memberFieldsTruncated += projectedFieldCount
    usedBytes += metrics.bytes + 1
    usedTokens += metrics.estimatedTokens
  }

  while (true) {
    const truncation = {
      membersOmitted: sortedMembers.length - members.length,
      memberFieldsTruncated,
    }
    const snapshot: RoomSnapshot = {
      id: room.id,
      workspaceId: room.workspaceId,
      memberKey: room.memberKey,
      members,
      eventCount: room.events.length,
      latestSequence: Math.max(0, room.nextSequence - 1),
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      ...(truncation.membersOmitted > 0 || truncation.memberFieldsTruncated > 0
        ? { truncation }
        : {}),
    }
    if (fitsSerializedBudget(snapshot, budget) || members.length === 0) return snapshot
    if (members.pop()?.truncation) memberFieldsTruncated -= 1
  }
}

import type {
  RelayChannelMessageDraft,
  RelayDirectMessageDraft,
  RelayEvent,
  RelaySpawnRequest,
  RelayWorkContext,
} from '../../../packages/codesurf-relay/src'
import {
  CodesurfRelay,
  RelayRuntime,
} from '../../../packages/codesurf-relay/src'
import type { TileState } from '../../shared/types'
import { bus } from '../event-bus'
import { loadWorkspaceTileState } from '../storage/workspaceArtifacts'
import { broadcastToRenderer } from '../utils/broadcast'
import { createMainProcessRelayExecutor } from './provider-executor'
import {
  WorkspaceRelayService,
  type RelayOperationGuard,
} from './workspaceRelayService'

export {
  RelayOperationCancelledError,
  WorkspaceRelayService,
} from './workspaceRelayService'
export type {
  RelayOperationGuard,
  WorkspaceRelayInstance,
  WorkspaceRelayServiceDependencies,
} from './workspaceRelayService'

function broadcast(event: RelayEvent, workspacePath: string): void {
  const channel = event.type === 'channel_message' && 'channel' in event.payload
    ? `relay:channel:${event.payload.channel}`
    : event.type === 'direct_message' && 'to' in event.payload
      ? `relay:participant:${event.payload.to}`
      : 'relay:system'

  bus.publish({
    channel,
    type: 'data',
    source: 'relay',
    payload: { workspacePath, event },
  })

  broadcastToRenderer('relay:event', { workspacePath, event })
}

const relayService = new WorkspaceRelayService({
  createRelay: workspacePath => new CodesurfRelay({ workspacePath }),
  createRuntime: (relay, options) => new RelayRuntime(relay, options),
  createExecutor: (participant, request) => (
    createMainProcessRelayExecutor(participant.id, request)
  ),
  readTileState: (workspaceId, tileId) => (
    loadWorkspaceTileState(workspaceId, tileId, null)
  ),
  broadcast,
})

export function startRelayServices(): void {
  relayService.start()
}

export function captureRelayServiceGeneration(): number | null {
  return relayService.captureGeneration()
}

export function isRelayServiceGenerationActive(generation: number): boolean {
  return relayService.isGenerationActive(generation)
}

export function getWorkspaceRelay(
  workspacePath: string,
  guard?: RelayOperationGuard,
) {
  return relayService.getWorkspaceRelay(workspacePath, guard)
}

export function syncWorkspaceRelayParticipants(
  workspaceId: string,
  workspacePath: string,
  tiles: TileState[],
  guard?: RelayOperationGuard,
) {
  return relayService.syncWorkspaceRelayParticipants(
    workspaceId,
    workspacePath,
    tiles,
    guard,
  )
}

export function spawnWorkspaceRelayAgent(
  workspacePath: string,
  request: RelaySpawnRequest,
) {
  return relayService.spawnWorkspaceRelayAgent(workspacePath, request)
}

export function stopWorkspaceRelayAgent(
  workspacePath: string,
  participantId: string,
): Promise<void> {
  return relayService.stopWorkspaceRelayAgent(workspacePath, participantId)
}

export function sendWorkspaceDirectRelayMessage(
  workspacePath: string,
  from: string,
  draft: RelayDirectMessageDraft,
) {
  return relayService.sendWorkspaceDirectRelayMessage(
    workspacePath,
    from,
    draft,
  )
}

export function sendWorkspaceChannelRelayMessage(
  workspacePath: string,
  from: string,
  draft: RelayChannelMessageDraft,
) {
  return relayService.sendWorkspaceChannelRelayMessage(
    workspacePath,
    from,
    draft,
  )
}

export function listWorkspaceRelayParticipants(workspacePath: string) {
  return relayService.listWorkspaceRelayParticipants(workspacePath)
}

export function listWorkspaceRelayChannels(workspacePath: string) {
  return relayService.listWorkspaceRelayChannels(workspacePath)
}

export function listWorkspaceRelayCentralFeed(
  workspacePath: string,
  limit?: number,
) {
  return relayService.listWorkspaceRelayCentralFeed(workspacePath, limit)
}

export function listWorkspaceRelayMessages(
  workspacePath: string,
  participantId: string,
  mailbox: 'inbox' | 'sent' | 'memory' | 'bin',
  limit?: number,
) {
  return relayService.listWorkspaceRelayMessages(
    workspacePath,
    participantId,
    mailbox,
    limit,
  )
}

export function readWorkspaceRelayMessage(
  workspacePath: string,
  participantId: string,
  mailbox: 'inbox' | 'sent' | 'memory' | 'bin',
  filename: string,
) {
  return relayService.readWorkspaceRelayMessage(
    workspacePath,
    participantId,
    mailbox,
    filename,
  )
}

export function updateWorkspaceRelayMessageStatus(
  workspacePath: string,
  participantId: string,
  mailbox: 'inbox' | 'sent' | 'memory' | 'bin',
  filename: string,
  status: 'unread' | 'read' | 'sent' | 'archived',
) {
  return relayService.updateWorkspaceRelayMessageStatus(
    workspacePath,
    participantId,
    mailbox,
    filename,
    status,
  )
}

export function moveWorkspaceRelayMessage(
  workspacePath: string,
  participantId: string,
  fromMailbox: 'inbox' | 'sent' | 'memory' | 'bin',
  toMailbox: 'inbox' | 'sent' | 'memory' | 'bin',
  filename: string,
) {
  return relayService.moveWorkspaceRelayMessage(
    workspacePath,
    participantId,
    fromMailbox,
    toMailbox,
    filename,
  )
}

export function setWorkspaceRelayWorkContext(
  workspacePath: string,
  participantId: string,
  work: RelayWorkContext,
) {
  return relayService.setWorkspaceRelayWorkContext(
    workspacePath,
    participantId,
    work,
  )
}

export function analyzeWorkspaceRelayRelationships(workspacePath: string) {
  return relayService.analyzeWorkspaceRelayRelationships(workspacePath)
}

export function waitForWorkspaceRelayReady(
  workspacePath: string,
  ids: string[],
  timeoutMs?: number,
) {
  return relayService.waitForWorkspaceRelayReady(
    workspacePath,
    ids,
    timeoutMs,
  )
}

export function waitForWorkspaceRelayAny(
  workspacePath: string,
  ids: string[],
  timeoutMs?: number,
) {
  return relayService.waitForWorkspaceRelayAny(
    workspacePath,
    ids,
    timeoutMs,
  )
}

export function stopAllRelayServices(): Promise<void> {
  return relayService.stopAll()
}

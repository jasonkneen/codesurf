import { ipcMain } from 'electron'
import {
  analyzeWorkspaceRelayRelationships,
  getWorkspaceRelay,
  listWorkspaceRelayCentralFeed,
  listWorkspaceRelayChannels,
  listWorkspaceRelayMessages,
  listWorkspaceRelayParticipants,
  moveWorkspaceRelayMessage,
  readWorkspaceRelayMessage,
  sendWorkspaceChannelRelayMessage,
  sendWorkspaceDirectRelayMessage,
  setWorkspaceRelayWorkContext,
  spawnWorkspaceRelayAgent,
  startRelayServices,
  stopAllRelayServices,
  stopWorkspaceRelayAgent,
  syncWorkspaceRelayParticipants,
  updateWorkspaceRelayMessageStatus,
  waitForWorkspaceRelayAny,
  waitForWorkspaceRelayReady,
} from '../relay/service'
import type { TileState } from '../../shared/types'
import { setRelayHostActive } from '../relay/registration'
import {
  activateCanvasRelayProjectionSync,
  deactivateCanvasRelayProjectionSync,
} from '../relay/canvasProjection'
import {
  isRelayChannelMessageDraft,
  isRelayDirectMessageDraft,
  isRelaySpawnRequest,
  isRelayWorkContext,
} from '../relay/ipc-validation'

const RELAY_CHANNELS = [
  'relay:init',
  'relay:syncWorkspace',
  'relay:listParticipants',
  'relay:listChannels',
  'relay:listCentralFeed',
  'relay:listMessages',
  'relay:readMessage',
  'relay:sendDirectMessage',
  'relay:sendChannelMessage',
  'relay:updateMessageStatus',
  'relay:moveMessage',
  'relay:setWorkContext',
  'relay:analyzeRelationships',
  'relay:spawnAgent',
  'relay:stopAgent',
  'relay:waitForReady',
  'relay:waitForAny',
] as const

export function registerRelayIPC(): void {
  removeRelayIPCHandlers()
  startRelayServices()
  setRelayHostActive(true)
  activateCanvasRelayProjectionSync()

  ipcMain.handle('relay:init', async (_, workspacePath: string) => {
    await getWorkspaceRelay(workspacePath)
    return true
  })

  ipcMain.handle('relay:syncWorkspace', async (_, workspaceId: string, workspacePath: string, tiles: TileState[]) => {
    return syncWorkspaceRelayParticipants(workspaceId, workspacePath, tiles)
  })

  ipcMain.handle('relay:listParticipants', async (_, workspacePath: string) => {
    return listWorkspaceRelayParticipants(workspacePath)
  })

  ipcMain.handle('relay:listChannels', async (_, workspacePath: string) => {
    return listWorkspaceRelayChannels(workspacePath)
  })

  ipcMain.handle('relay:listCentralFeed', async (_, workspacePath: string, limit?: number) => {
    return listWorkspaceRelayCentralFeed(workspacePath, limit)
  })

  ipcMain.handle('relay:listMessages', async (_, workspacePath: string, participantId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', limit?: number) => {
    return listWorkspaceRelayMessages(workspacePath, participantId, mailbox, limit)
  })

  ipcMain.handle('relay:readMessage', async (_, workspacePath: string, participantId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string) => {
    return readWorkspaceRelayMessage(workspacePath, participantId, mailbox, filename)
  })

  ipcMain.handle('relay:sendDirectMessage', async (_, workspacePath: string, from: string, draft: unknown) => {
    if (
      typeof workspacePath !== 'string' || typeof from !== 'string' ||
      !isRelayDirectMessageDraft(draft)
    ) {
      throw new TypeError('Invalid sendDirectMessage payload')
    }
    return sendWorkspaceDirectRelayMessage(workspacePath, from, draft)
  })

  ipcMain.handle('relay:sendChannelMessage', async (_, workspacePath: string, from: string, draft: unknown) => {
    if (
      typeof workspacePath !== 'string' || typeof from !== 'string' ||
      !isRelayChannelMessageDraft(draft)
    ) {
      throw new TypeError('Invalid sendChannelMessage payload')
    }
    return sendWorkspaceChannelRelayMessage(workspacePath, from, draft)
  })

  ipcMain.handle('relay:updateMessageStatus', async (_, workspacePath: string, participantId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string, status: 'unread' | 'read' | 'sent' | 'archived') => {
    return updateWorkspaceRelayMessageStatus(workspacePath, participantId, mailbox, filename, status)
  })

  ipcMain.handle('relay:moveMessage', async (_, workspacePath: string, participantId: string, fromMailbox: 'inbox' | 'sent' | 'memory' | 'bin', toMailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string) => {
    return moveWorkspaceRelayMessage(workspacePath, participantId, fromMailbox, toMailbox, filename)
  })

  ipcMain.handle('relay:setWorkContext', async (_, workspacePath: string, participantId: string, work: unknown) => {
    if (
      typeof workspacePath !== 'string' ||
      typeof participantId !== 'string' ||
      !isRelayWorkContext(work)
    ) {
      throw new TypeError('Invalid setWorkContext payload')
    }
    return setWorkspaceRelayWorkContext(workspacePath, participantId, work)
  })

  ipcMain.handle('relay:analyzeRelationships', async (_, workspacePath: string) => {
    return analyzeWorkspaceRelayRelationships(workspacePath)
  })

  ipcMain.handle('relay:spawnAgent', async (_, workspacePath: string, request: unknown) => {
    if (
      typeof workspacePath !== 'string' ||
      !isRelaySpawnRequest(request)
    ) {
      throw new TypeError('Invalid spawnAgent payload')
    }
    return spawnWorkspaceRelayAgent(workspacePath, request)
  })

  ipcMain.handle('relay:stopAgent', async (_, workspacePath: string, participantId: string) => {
    await stopWorkspaceRelayAgent(workspacePath, participantId)
    return true
  })

  ipcMain.handle('relay:waitForReady', async (_, workspacePath: string, ids: string[], timeoutMs?: number) => {
    return waitForWorkspaceRelayReady(workspacePath, ids, timeoutMs)
  })

  ipcMain.handle('relay:waitForAny', async (_, workspacePath: string, ids: string[], timeoutMs?: number) => {
    return waitForWorkspaceRelayAny(workspacePath, ids, timeoutMs)
  })
}

function removeRelayIPCHandlers(): void {
  deactivateCanvasRelayProjectionSync()
  setRelayHostActive(false)
  for (const ch of RELAY_CHANNELS) {
    try {
      ipcMain.removeHandler(ch)
    } catch {
      /* ignore */
    }
  }
}

export async function unregisterRelayIPC(): Promise<void> {
  removeRelayIPCHandlers()
  // Removing the ordinary entry points and invalidating the service generation
  // are one lifecycle operation. Any handler already suspended in init/spawn
  // observes the inactive generation before it can publish fresh resources.
  await stopAllRelayServices()
}

import { ipcMain } from 'electron'
import {
  upsertActivity,
  queryActivity,
  getActivityByTile,
  deleteActivity,
  clearTileActivity,
  getActivityByAgent,
} from '../activity-store'
import type { ActivityQuery, ActivityType, ActivityStatus } from '../../shared/types'

export function registerActivityIPC(): void {
  ipcMain.handle('activity:upsert', (_, workspaceId: string, data: {
    id?: string
    tileId: string
    type: ActivityType
    status?: ActivityStatus
    title: string
    detail?: string
    metadata?: Record<string, unknown>
    agent?: string
  }) => {
    return upsertActivity(workspaceId, data)
  })

  ipcMain.handle('activity:query', (_, query: ActivityQuery) => {
    return queryActivity(query)
  })

  ipcMain.handle('activity:byTile', (_, workspaceId: string, tileId: string) => {
    return getActivityByTile(workspaceId, tileId)
  })

  ipcMain.handle('activity:delete', (_, workspaceId: string, id: string) => {
    return deleteActivity(workspaceId, id)
  })

  ipcMain.handle('activity:clearTile', (_, workspaceId: string, tileId: string) => {
    return clearTileActivity(workspaceId, tileId)
  })

  ipcMain.handle('activity:byAgent', (_, workspaceId: string) => {
    return getActivityByAgent(workspaceId)
  })
}

import { ipcMain } from 'electron'
import {
  upsertActivity,
  queryActivity,
  getActivityByTile,
  deleteActivity,
  clearTileActivity,
  getActivityByAgent,
  getActivityHealth,
} from '../activity-store'
import { createActivityIPCHandlers } from '../activity-ipc-handlers.ts'

export function registerActivityIPC(): void {
  const handlers = createActivityIPCHandlers({
    upsert: upsertActivity,
    query: queryActivity,
    byTile: getActivityByTile,
    delete: deleteActivity,
    clearTile: clearTileActivity,
    byAgent: getActivityByAgent,
    health: getActivityHealth,
  })
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, handler)
  }
}

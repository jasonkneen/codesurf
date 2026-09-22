import { ipcMain } from 'electron'
import { daemonClient } from '../daemon/client'
import { ensureDaemonRunning } from '../daemon/manager'

export function registerDreamingIPC(): void {
  ipcMain.handle('dreaming:status', async (_, workspaceId: string) => {
    await ensureDaemonRunning()
    return await daemonClient.getDreamStatus(workspaceId)
  })

  ipcMain.handle('dreaming:listRuns', async (_, args: { workspaceId: string; limit?: number }) => {
    await ensureDaemonRunning()
    return await daemonClient.listDreamRuns(String(args?.workspaceId ?? '').trim(), args?.limit)
  })

  ipcMain.handle('dreaming:run', async (_, args: { workspaceId: string; provider?: string; model?: string; maxSessions?: number }) => {
    await ensureDaemonRunning()
    return await daemonClient.runDream(args)
  })

  ipcMain.handle('dreaming:cancel', async (_, args: { workspaceId: string; runId?: string | null }) => {
    await ensureDaemonRunning()
    return await daemonClient.cancelDream(args)
  })
}

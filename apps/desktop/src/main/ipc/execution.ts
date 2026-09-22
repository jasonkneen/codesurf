import { ipcMain } from 'electron'
import type { ExecutionHostRecord, ExecutionPreference } from '../../shared/types'
import { daemonClient } from '../daemon/client'
import { ensureDaemonRunning, getDaemonStatus } from '../daemon/manager'
import { getBuiltinExecutionHosts, resolveExecutionTarget } from '../execution/targets'

async function listExecutionHostsSafe(): Promise<ExecutionHostRecord[]> {
  try {
    await ensureDaemonRunning()
    return await daemonClient.listHosts()
  } catch {
    return getBuiltinExecutionHosts()
  }
}

export function registerExecutionIPC(): void {
  ipcMain.handle('execution:listHosts', async () => {
    await ensureDaemonRunning()
    return await daemonClient.listHosts()
  })

  ipcMain.handle('execution:upsertHost', async (_, host: ExecutionHostRecord) => {
    await ensureDaemonRunning()
    return await daemonClient.upsertHost(host)
  })

  ipcMain.handle('execution:deleteHost', async (_, id: string) => {
    await ensureDaemonRunning()
    return await daemonClient.deleteHost(id)
  })

  ipcMain.handle('execution:resolveTarget', async (_, preference: ExecutionPreference) => {
    const [hosts, daemonStatus] = await Promise.all([
      listExecutionHostsSafe(),
      getDaemonStatus(),
    ])

    return resolveExecutionTarget({
      hosts,
      preference,
      localDaemonAvailable: daemonStatus.running === true,
    })
  })
}

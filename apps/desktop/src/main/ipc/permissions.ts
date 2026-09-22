import { ipcMain } from 'electron'
import { clearAllPermissionGrants, clearPermissionGrant, getPermissionsStorePath, listPermissionGrants } from '../permissions'

export function registerPermissionsIPC(): void {
  ipcMain.handle('permissions:list', async () => {
    return {
      path: getPermissionsStorePath(),
      grants: listPermissionGrants(),
    }
  })

  ipcMain.handle('permissions:clear', async (_, id: string) => {
    return {
      path: getPermissionsStorePath(),
      grants: clearPermissionGrant(String(id ?? '').trim()),
    }
  })

  ipcMain.handle('permissions:clearAll', async () => {
    return {
      path: getPermissionsStorePath(),
      grants: clearAllPermissionGrants(),
    }
  })
}

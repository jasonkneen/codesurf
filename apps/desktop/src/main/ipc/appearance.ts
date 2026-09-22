import { ipcMain, nativeTheme } from 'electron'
import { broadcastToRenderer } from '../utils/broadcast'

function broadcastAppearanceToRenderers(): void {
  broadcastToRenderer('appearance:updated', { shouldUseDark: nativeTheme.shouldUseDarkColors })
}

export function registerAppearanceIPC(): void {
  // Native dark/light preference — drives "system" appearance in renderer
  nativeTheme.on('updated', broadcastAppearanceToRenderers)

  ipcMain.handle('appearance:shouldUseDark', () => nativeTheme.shouldUseDarkColors)
  ipcMain.handle('appearance:setThemeSource', (_, mode: string) => {
    if (mode === 'dark' || mode === 'light' || mode === 'system') {
      nativeTheme.themeSource = mode
    }
    broadcastAppearanceToRenderers()
    return true
  })
}

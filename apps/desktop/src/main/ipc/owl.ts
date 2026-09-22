import { app, ipcMain } from 'electron'
import { getOwlSupervisor, stopOwlSupervisor } from '../owl/runtime'
import { APP_NAME } from '../paths'

export function registerOwlIPC(): void {
  const callOwl = (method: string, params?: Record<string, unknown>) =>
    getOwlSupervisor().call(method, (params ?? {}) as Record<string, never>)

  ipcMain.handle('owl:health', () => callOwl('health'))
  ipcMain.handle('owl:session:create', (_event, options: {
    appName?: string
    buildFlavor?: string
  } = {}) => callOwl('session.create', {
    appName: typeof options.appName === 'string' && options.appName.trim() ? options.appName.trim() : APP_NAME,
    buildFlavor: typeof options.buildFlavor === 'string' ? options.buildFlavor : app.isPackaged ? 'prod' : 'dev',
  }))
  ipcMain.handle('owl:profile:create', (_event, options: {
    sessionId: string
    name?: string
    persistent?: boolean
    storageKey?: string
    isolateForAgent?: boolean
  }) => callOwl('profile.create', options as Record<string, unknown>))
  ipcMain.handle('owl:webview:create', (_event, options: {
    profileId: string
    initialUrl?: string
    width?: number
    height?: number
    deviceScaleFactor?: number
    visible?: boolean
  }) => callOwl('webview.create', options as Record<string, unknown>))
  ipcMain.handle('owl:webview:navigate', (_event, options: { webViewId: string; url: string }) =>
    callOwl('webview.navigate', options))
  ipcMain.handle('owl:webview:setGeometry', (_event, options: {
    webViewId: string
    width: number
    height: number
    deviceScaleFactor?: number
  }) => callOwl('webview.setGeometry', options as Record<string, unknown>))
  ipcMain.handle('owl:webview:dispatchInput', (_event, options: {
    webViewId: string
    route?: 'content' | 'browser'
    event: Record<string, unknown>
  }) => callOwl('webview.dispatchInput', options as Record<string, unknown>))
  ipcMain.handle('owl:webview:capture', (_event, options: { webViewId: string; includePopups?: boolean }) =>
    callOwl('webview.capture', options as Record<string, unknown>))
  ipcMain.handle('owl:webview:destroy', (_event, webViewId: string) =>
    callOwl('webview.destroy', { webViewId }))
  ipcMain.handle('owl:stop', () => {
    stopOwlSupervisor()
    return { ok: true }
  })
}

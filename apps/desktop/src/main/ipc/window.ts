import { app, BrowserWindow, ipcMain } from 'electron'
import { APP_NAME } from '../paths'

export interface WindowIPCContext {
  createWindow: (opts?: {
    fresh?: boolean
    workspaceId?: string | null
    workspacePicker?: boolean
    nativeTabOwner?: BrowserWindow | null
    devSandbox?: boolean
  }) => BrowserWindow
  createWorkspaceTab: (owner: BrowserWindow | null, opts?: {
    fresh?: boolean
    workspaceId?: string | null
    workspacePicker?: boolean
    nativeTabOwner?: BrowserWindow | null
    devSandbox?: boolean
  }) => BrowserWindow
  createMiniChatWindow: (owner: BrowserWindow | null, request: {
    workspaceId?: unknown
    tileId?: unknown
    title?: unknown
  }) => { ok: boolean; id?: number; error?: string }
  getFocusedMainWindow: () => BrowserWindow | null
  getLiveWindows: () => BrowserWindow[]
  windowTitles: Map<number, string>
  freshWindowIds: Set<number>
  broadcastWindowList: () => void
  openExternalIfSafe: (rawUrl: string, source: 'window' | 'ipc') => Promise<boolean>
}

export function registerWindowIPC(ctx: WindowIPCContext): void {
  ipcMain.handle('window:new', () => { ctx.createWindow({ fresh: true }); return null })
  // Dev Sandbox: a fresh, visibly-marked instance for testing plugins in isolation.
  ipcMain.handle('window:openDevSandbox', () => { ctx.createWindow({ fresh: true, devSandbox: true, workspacePicker: true }); return null })
  ipcMain.handle('window:newTab', (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? ctx.getFocusedMainWindow()
    if (process.platform === 'darwin') {
      ctx.createWorkspaceTab(owner, { fresh: true, workspacePicker: true })
    } else {
      ctx.createWindow({ fresh: true })
    }
    return null
  })
  ipcMain.handle('window:newWorkspaceTab', (event, workspaceId?: unknown) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? ctx.getFocusedMainWindow()
    const id = typeof workspaceId === 'string' ? workspaceId.trim() : ''
    const win = process.platform === 'darwin'
      ? ctx.createWorkspaceTab(owner, { fresh: true, workspaceId: id || null, workspacePicker: !id })
      : ctx.createWindow({ fresh: true, workspaceId: id || null, workspacePicker: !id })
    return { id: win.webContents.id }
  })
  ipcMain.handle('window:isFresh', (event) => {
    const id = event.sender.id
    const isFresh = ctx.freshWindowIds.has(id)
    if (isFresh) {
      ctx.freshWindowIds.delete(id)
      return true
    }
    return false
  })

  ipcMain.handle('window:list', () => {
    const wins = ctx.getLiveWindows()
    const focused = BrowserWindow.getFocusedWindow()
    const focusedId = focused && !focused.isDestroyed() && !focused.webContents.isDestroyed()
      ? focused.webContents.id
      : undefined
    return wins.map(w => ({
      id: w.webContents.id,
      title: ctx.windowTitles.get(w.webContents.id) ?? APP_NAME,
      focused: w.webContents.id === focusedId,
    }))
  })

  ipcMain.handle('window:getCurrentId', (event) => event.sender.id)

  ipcMain.handle('window:setTitle', (event, title: string) => {
    const cleanTitle = typeof title === 'string' && title.trim().length > 0 ? title.trim() : APP_NAME
    ctx.windowTitles.set(event.sender.id, cleanTitle)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) win.setTitle(cleanTitle)
    ctx.broadcastWindowList()
  })

  ipcMain.handle('window:focusById', (_, id: number) => {
    const win = ctx.getLiveWindows().find(w => w.webContents.id === id)
    win?.focus()
  })

  ipcMain.handle('window:closeById', (_, id: number) => {
    const win = ctx.getLiveWindows().find(w => w.webContents.id === id)
    win?.close()
  })

  ipcMain.handle('window:openMiniChat', (event, request: { workspaceId?: unknown; tileId?: unknown; title?: unknown }) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    return ctx.createMiniChatWindow(owner, request ?? {})
  })

  ipcMain.handle('window:setSidebarCollapsed', (event, collapsed: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return !!win && typeof collapsed === 'boolean'
  })

  ipcMain.handle('app:relaunch', () => {
    app.relaunch()
    app.quit()
  })

  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    return await ctx.openExternalIfSafe(url, 'ipc')
  })
}

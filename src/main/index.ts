import { app, BrowserWindow, shell, ipcMain, Menu, nativeTheme, nativeImage, session, systemPreferences, desktopCapturer } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { initWorkspaces, registerWorkspaceIPC } from './ipc/workspace'
import { registerFsIPC } from './ipc/fs'
import { registerCanvasIPC } from './ipc/canvas'
import { registerTerminalIPC } from './ipc/terminal'
import { startMCPServer, getMCPPort, setExtensionRegistryProvider } from './mcp-server'
import { registerAgentsIPC } from './ipc/agents'
import { registerStreamIPC } from './ipc/stream'
import { registerGitIPC } from './ipc/git'
import { registerBusIPC } from './ipc/bus'
import { registerChatIPC } from './ipc/chat'
import { registerActivityIPC } from './ipc/activity'
import { registerCollabIPC, stopAllCollabWatchers } from './ipc/collab'
import { registerTileContextIPC } from './ipc/tile-context'
import { registerSystemIPC } from './ipc/system'
import { registerExecutionIPC } from './ipc/execution'
import { registerPermissionsIPC } from './ipc/permissions'
import { getSavedZoomLevel, registerUIIPC } from './ipc/ui'
import { registerFileProtocol } from './file-protocol'
import { flushAll as flushActivityStore } from './activity-store'
import { initializeAgentPathsCache, registerAgentPathsIPC } from './agent-paths'
import { ExtensionRegistry } from './extensions/registry'
import { registerExtensionProtocol } from './extensions/protocol'
import { registerExtensionIPC } from './ipc/extensions'
import { registerChromeSyncIPC } from './ipc/chromeSync'
import { registerLocalProxyIPC } from './ipc/localProxy'
import { applyWindowAppearance, getWindowAppearanceOptions } from './windowAppearance'
import { migrateLegacyStorage } from './migration'
import { APP_ID, APP_NAME, CONTEX_HOME } from './paths'
import { closeDb, getDb, getDbStatus } from './db'
import { ensureInitialIndex } from './db/thread-indexer'
import { stopAllRelayServices } from './relay/service'
// browserTile BrowserView IPC was removed — renderer uses <webview> tag directly

const DEFAULT_MAX_OLD_SPACE_SIZE_MB = 8192
const envMaxOldSpaceSizeMb = Number.parseInt(process.env.CODESURF_MAX_OLD_SPACE_SIZE_MB ?? '', 10)
const maxOldSpaceSizeMb = Number.isFinite(envMaxOldSpaceSizeMb) && envMaxOldSpaceSizeMb > 0
  ? envMaxOldSpaceSizeMb
  : DEFAULT_MAX_OLD_SPACE_SIZE_MB

// Expose global.gc() in renderer processes and keep the Electron V8 flag budget
// aligned with the standalone launcher override.
app.commandLine.appendSwitch('js-flags', `--expose-gc --max-old-space-size=${maxOldSpaceSizeMb}`)

// Per-window display titles (webContents.id → label set by renderer via workspace name)
const windowTitles = new Map<number, string>()
const freshWindowIds = new Set<number>()
let extensionRegistry: ExtensionRegistry | null = null

function resolveBundledExtensionDirs(): string[] {
  const envDir = process.env.CODESURF_BUNDLED_EXTENSIONS_DIR
  const candidates = [
    envDir ?? '',
    join(app.getAppPath(), 'bundled-extensions'),
    join(app.getAppPath(), 'resources', 'bundled-extensions'),
    join(process.resourcesPath, 'bundled-extensions'),
  ]

  return [...new Set(candidates.filter(candidate => existsSync(candidate)))]
}

function resolveAppIconPath(): string | null {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  const candidates = [
    join(process.resourcesPath, iconName),
    join(process.resourcesPath, 'resources', iconName),
    join(app.getAppPath(), 'resources', iconName),
    join(app.getAppPath(), '..', 'resources', iconName),
    join(__dirname, `../../resources/${iconName}`),
    // Fallback to PNG on any platform
    join(process.resourcesPath, 'icon.png'),
    join(app.getAppPath(), 'resources', 'icon.png'),
    join(__dirname, '../../resources/icon.png'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  return null
}

function applyRuntimeAppBranding(): void {
  const iconPath = resolveAppIconPath()
  if (iconPath && process.platform === 'darwin') {
    try {
      app.dock.setIcon(nativeImage.createFromPath(iconPath))
    } catch (err) {
      console.warn('[app] Failed to set dock icon:', err)
    }
  }

  app.setName(APP_NAME)
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
  })
}

function getLiveWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(w => !w.isDestroyed() && !w.webContents.isDestroyed())
}

function broadcastAppearanceToRenderers(): void {
  const payload = { shouldUseDark: nativeTheme.shouldUseDarkColors }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send('appearance:updated', payload)
  }
}

function broadcastWindowList(): void {
  const wins = getLiveWindows()
  const focused = BrowserWindow.getFocusedWindow()
  const focusedId = focused && !focused.isDestroyed() && !focused.webContents.isDestroyed()
    ? focused.webContents.id
    : undefined
  const list = wins.map(w => ({
    id: w.webContents.id,
    title: windowTitles.get(w.webContents.id) ?? 'CodeSurf',
    focused: w.webContents.id === focusedId,
  }))
  for (const w of wins) {
    try {
      w.webContents.send('window:list-changed', list)
    } catch {
      // Window's render frame may be disposed during focus transitions
    }
  }
}

async function requestMacMediaAccess(kind: 'microphone' | 'camera'): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  try {
    return await systemPreferences.askForMediaAccess(kind)
  } catch (error) {
    console.warn(`[Permissions] Failed requesting ${kind} access:`, error)
    return false
  }
}

function installMediaPermissionHandlers(): void {
  const defaultSession = session.defaultSession
  if (!defaultSession) return

  defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media' || permission === 'display-capture'
  })

  defaultSession.setPermissionRequestHandler(async (_webContents, permission, callback) => {
    try {
      if (permission === 'media') {
        const [micAllowed, camAllowed] = await Promise.all([
          requestMacMediaAccess('microphone'),
          requestMacMediaAccess('camera'),
        ])
        callback(micAllowed || camAllowed)
        return
      }

      if (permission === 'display-capture') {
        callback(true)
        return
      }

      callback(false)
    } catch (error) {
      console.warn('[Permissions] Permission request failed:', error)
      callback(false)
    }
  })

  defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
      callback(
        sources[0]
          ? { video: sources[0], audio: 'loopback' as any }
          : {},
      )
    } catch (error) {
      console.warn('[Permissions] Display media request failed:', error)
      callback({})
    }
  })
}

function createWindow(opts?: { fresh?: boolean }): BrowserWindow {
  const iconPath = resolveAppIconPath()
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin',
    ...(iconPath ? { icon: iconPath } : {}),
    ...getWindowAppearanceOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })
  const windowId = win.webContents.id

  win.on('ready-to-show', () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    applyWindowAppearance(win)
    win.setTitle('') // hide native title text; our pill tabs show workspace name
    win.show()
    broadcastWindowList()
  })

  // Electron's built-in per-origin zoom restore is unreliable in practice —
  // users were opening to a drastically zoomed UI even after Cmd+0. Restore
  // the zoom level ourselves from ~/.codesurf/ui-state.json on every load
  // so the choice persists deterministically across launches.
  win.webContents.on('did-finish-load', async () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    const level = await getSavedZoomLevel()
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.setZoomLevel(level)
  })

  win.on('focus', () => broadcastWindowList())
  win.on('blur', () => broadcastWindowList())

  win.on('closed', () => {
    windowTitles.delete(windowId)
    broadcastWindowList()
  })
  win.on('unresponsive', () => {
    console.error(`[window:${windowId}] BrowserWindow became unresponsive`)
  })
  win.webContents.on('render-process-gone', (_, details) => {
    console.error(`[window:${windowId}] Renderer process gone`, details)
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Track fresh windows so renderer can query via IPC
  if (opts?.fresh) {
    freshWindowIds.add(win.webContents.id)
  }

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(async () => {
  applyRuntimeAppBranding()
  installMediaPermissionHandlers()
  electronApp.setAppUserModelId(APP_ID)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  await migrateLegacyStorage()

  // Open (or create) the local SQLite database and apply pending schema
  // migrations. Phase 2 uses this DB for the threads index; the UI always
  // has a legacy-walker fallback behind the `storage.threadIndex` flag.
  try {
    getDb()
    const status = getDbStatus()
    // eslint-disable-next-line no-console
    console.log(`[db] Ready at ${status.path} (schema v${status.schemaVersion}, tables: ${status.tables.join(', ') || '—'})`)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[db] Failed to initialise local database:', err)
  }

  // Populate the thread index ONCE if the DB is empty. On every subsequent
  // launch this is effectively a no-op (zero filesystem work). The scan runs
  // in the background so it never blocks boot.
  void ensureInitialIndex().catch(err => {
    // eslint-disable-next-line no-console
    console.warn('[threads] initial index failed:', err)
  })

  // Init workspace dirs + register all IPC handlers
  await initWorkspaces()
  registerWorkspaceIPC()
  registerFsIPC()
  registerCanvasIPC()
  registerTerminalIPC()
  registerAgentsIPC()
  registerStreamIPC()
  registerGitIPC()
  registerBusIPC()
  registerChatIPC()
  registerActivityIPC()
  registerCollabIPC()
  registerTileContextIPC()
  registerSystemIPC()
  registerExecutionIPC()
  registerPermissionsIPC()
  registerUIIPC()
  registerFileProtocol()
  registerAgentPathsIPC()
  registerChromeSyncIPC()
  registerLocalProxyIPC()

  // Keep the extension system fully lazy. Do not scan or boot extension hosts
  // at startup; load them only when an extension tile or explicit management UI asks.
  extensionRegistry = new ExtensionRegistry({ bundledDirs: resolveBundledExtensionDirs() })
  registerExtensionProtocol(extensionRegistry)
  registerExtensionIPC(extensionRegistry)
  setExtensionRegistryProvider(() => extensionRegistry)

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

  // Prime cached agent paths from disk only. Full binary detection is deferred
  // until setup/manual refresh so startup does not shell out across all agents.
  initializeAgentPathsCache().catch(err => console.error('[AgentPaths] Cache init failed:', err))
  // registerBrowserTileIPC() — removed, renderer uses <webview> tag directly

  // Start local MCP server for agent→kanban callbacks
  startMCPServer().then(port => {
    console.log(`[MCP] Kanban tools available at http://127.0.0.1:${port}`)
  }).catch(err => console.error('[MCP] Failed to start:', err))

  // Expose MCP port to renderer
  ipcMain.handle('mcp:getPort', () => getMCPPort())

  // MCP config read/write
  const { join: pjoin } = await import('path')
  const mcpConfigPath = pjoin(CONTEX_HOME, 'mcp-server.json')
  const getRuntimeContexBase = (): string | undefined => {
    const port = getMCPPort()
    return port ? `http://127.0.0.1:${port}/mcp` : undefined
  }

  const normalizeMcpServer = (entry: unknown, fallbackUrl?: string): Record<string, unknown> => {
    if (!entry || typeof entry !== 'object') return fallbackUrl ? { type: 'http', url: fallbackUrl } : {}

    const server = { ...(entry as Record<string, unknown>) }

    if (server.url && typeof server.url === 'string') {
      server.url = server.url.replace(/\/$/, '')
    }

    // Support legacy "cmd" for command-based servers.
    if (!server.command && server.cmd && typeof server.cmd === 'string') {
      const parts = String(server.cmd).trim().split(/\s+/)
      server.command = parts[0]
      if (parts.length > 1) server.args = parts.slice(1)
    }

    if (!server.type) {
      if (server.command) {
        server.type = 'stdio'
      } else if (server.url || fallbackUrl) {
        server.type = 'http'
      }
    }

    if (!server.url && fallbackUrl) {
      server.url = fallbackUrl
    }

    return server
  }

  const normalizeMcpServers = (servers: Record<string, unknown>, fallbackUrlFn?: (name: string) => string | undefined): Record<string, Record<string, unknown>> => {
    const out: Record<string, Record<string, unknown>> = {}
    for (const [name, server] of Object.entries(servers ?? {})) {
      const fallbackUrl = fallbackUrlFn?.(name)
      const normalized = normalizeMcpServer(server, fallbackUrl)
      out[name] = normalized
    }
    return out
  }

  ipcMain.handle('mcp:getConfig', async () => {
    try {
      const { promises: fsP } = await import('fs')
      const raw = await fsP.readFile(mcpConfigPath, 'utf8')
      const cfg = JSON.parse(raw) as { mcpServers?: Record<string, unknown>, url?: string }
      const contexBase = (typeof cfg.url === 'string' ? `${cfg.url.replace(/\/$/, '')}/mcp` : undefined) ?? getRuntimeContexBase()
      const globalServers = cfg.mcpServers ?? {}
      const normalizedServers = normalizeMcpServers(globalServers, (name) => {
        if (name === 'contex' && contexBase) return contexBase
        return undefined
      })
      if (contexBase && !normalizedServers['contex']) {
        normalizedServers['contex'] = { type: 'http', url: contexBase }
      }
      return { ...cfg, mcpServers: normalizedServers }
    } catch { return null }
  })

  ipcMain.handle('mcp:saveServers', async (_, servers: Record<string, unknown>) => {
    try {
      const { promises: fsP } = await import('fs')
      const raw = await fsP.readFile(mcpConfigPath, 'utf8')
      const cfg = JSON.parse(raw) as { mcpServers?: Record<string, unknown>, url?: string }
      const contexBase = (typeof cfg.url === 'string' ? `${cfg.url.replace(/\/$/, '')}/mcp` : undefined) ?? getRuntimeContexBase()
      const contexServer = normalizeMcpServer(cfg.mcpServers?.contex ?? { url: contexBase }, contexBase)
      const customServers = normalizeMcpServers(servers)
      cfg.mcpServers = {
        contex: contexServer,
        ...customServers
      }
      cfg.updatedAt = new Date().toISOString()
      await fsP.writeFile(mcpConfigPath, JSON.stringify(cfg, null, 2))
      return cfg
    } catch (e) { return null }
  })

  // Per-workspace MCP servers
  ipcMain.handle('mcp:getWorkspaceServers', async (_, workspaceId: string) => {
    try {
      const { promises: fsP } = await import('fs')
      const p = pjoin(CONTEX_HOME, 'workspaces', workspaceId, 'mcp-servers.json')
      const raw = await fsP.readFile(p, 'utf8')
      return JSON.parse(raw)
    } catch { return {} }
  })

  ipcMain.handle('mcp:saveWorkspaceServers', async (_, workspaceId: string, servers: Record<string, unknown>) => {
    try {
      const { promises: fsP } = await import('fs')
      const dir = pjoin(CONTEX_HOME, 'workspaces', workspaceId)
      await fsP.mkdir(dir, { recursive: true })
      const p = pjoin(dir, 'mcp-servers.json')
      const normalized = normalizeMcpServers(servers)
      await fsP.writeFile(p, JSON.stringify(normalized, null, 2))
      return normalized
    } catch (e) { return null }
  })

  // Merged config for a workspace — global + workspace servers combined
  // This is what you'd point Claude Code / Cursor / any MCP client at
  ipcMain.handle('mcp:getMergedConfig', async (_, workspaceId: string) => {
    try {
      const { promises: fsP } = await import('fs')

      // Global config
      let globalCfg: Record<string, unknown> = {}
      try {
        const raw = await fsP.readFile(mcpConfigPath, 'utf8')
        globalCfg = JSON.parse(raw)
      } catch { /**/ }

      // Workspace servers
      let wsServers: Record<string, unknown> = {}
      try {
        const wsPath = pjoin(CONTEX_HOME, 'workspaces', workspaceId, 'mcp-servers.json')
        const raw = await fsP.readFile(wsPath, 'utf8')
        wsServers = JSON.parse(raw)
      } catch { /**/ }

      // Merge: global mcpServers + workspace servers
      const globalServers = (globalCfg as Record<string, Record<string, unknown>>).mcpServers ?? {}
      const globalCfgUrl = (globalCfg as { url?: string }).url
      const contexBase = (typeof globalCfgUrl === 'string' ? `${String(globalCfgUrl).replace(/\/$/, '')}/mcp` : undefined) ?? getRuntimeContexBase()

      const normalizedGlobal = normalizeMcpServers(globalServers, (name) => {
        if (name === 'contex' && contexBase) return contexBase
        return undefined
      })
      if (contexBase && !normalizedGlobal['contex']) {
        normalizedGlobal['contex'] = { type: 'http', url: contexBase }
      }
      const normalizedWorkspace = normalizeMcpServers(wsServers)

      const merged = {
        ...(globalCfg as object),
        mcpServers: {
          ...normalizedGlobal,
          ...normalizedWorkspace
        },
        workspace: workspaceId,
        mergedAt: new Date().toISOString()
      }

      // Also write a merged file inside .contex so it doesn't pollute the workspace root
      const wsContex = pjoin(CONTEX_HOME, 'workspaces', workspaceId, '.contex')
      await fsP.mkdir(wsContex, { recursive: true })
      await fsP.writeFile(
        pjoin(wsContex, 'mcp-merged.json'),
        JSON.stringify(merged, null, 2)
      )

      return merged
    } catch (e) { return null }
  })

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  ipcMain.handle('updater:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      const info = result?.updateInfo
      const updateAvailable = !!info && info.version !== app.getVersion()
      return {
        ok: true,
        currentVersion: app.getVersion(),
        status: updateAvailable ? 'update-available' : 'up-to-date',
        updateAvailable,
        updateInfo: info ? {
          version: info.version,
          releaseName: info.releaseName,
          releaseDate: info.releaseDate,
        } : undefined,
      }
    } catch (error) {
      return {
        ok: false,
        currentVersion: app.getVersion(),
        status: error instanceof Error ? error.message : 'update-check-failed',
        updateAvailable: false,
      }
    }
  })

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true, status: 'downloaded' }
    } catch (error) {
      return { ok: false, status: error instanceof Error ? error.message : 'download-failed' }
    }
  })

  ipcMain.handle('updater:quitAndInstall', async () => {
    setImmediate(() => autoUpdater.quitAndInstall())
    return { ok: true }
  })

  // Window management
  ipcMain.handle('window:new', () => { createWindow({ fresh: true }); return null })
  ipcMain.handle('window:newTab', () => { createWindow({ fresh: true }); return null })
  ipcMain.handle('window:isFresh', (event) => {
    const id = event.sender.id
    const isFresh = freshWindowIds.has(id)
    console.log(`[window:isFresh] id=${id} fresh=${isFresh} freshSet=[${[...freshWindowIds]}]`)
    if (isFresh) {
      freshWindowIds.delete(id)
      return true
    }
    return false
  })

  ipcMain.handle('window:list', () => {
    const wins = getLiveWindows()
    const focused = BrowserWindow.getFocusedWindow()
    const focusedId = focused && !focused.isDestroyed() && !focused.webContents.isDestroyed()
      ? focused.webContents.id
      : undefined
    return wins.map(w => ({
      id: w.webContents.id,
      title: windowTitles.get(w.webContents.id) ?? APP_NAME,
      focused: w.webContents.id === focusedId,
    }))
  })

  ipcMain.handle('window:getCurrentId', (event) => event.sender.id)

  ipcMain.handle('window:setTitle', (event, title: string) => {
    windowTitles.set(event.sender.id, title)
    broadcastWindowList()
  })

  ipcMain.handle('window:focusById', (_, id: number) => {
    const win = getLiveWindows().find(w => w.webContents.id === id)
    win?.focus()
  })

  ipcMain.handle('window:closeById', (_, id: number) => {
    const win = getLiveWindows().find(w => w.webContents.id === id)
    win?.close()
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
    if (typeof url !== 'string' || url.trim().length === 0) return false
    await shell.openExternal(url)
    return true
  })

  // Native app menu with Cmd+N / Cmd+T
  const menu = Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => createWindow({ fresh: true })
        },
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            const win = BrowserWindow.getFocusedWindow()
            if (win && !win.isDestroyed()) {
              win.webContents.send('workspace:newTab')
            }
          }
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'selectNextTab' },
        { role: 'selectPreviousTab' },
        { role: 'showAllTabs' },
        { role: 'mergeAllWindows' },
        { role: 'moveTabToNewWindow' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ])
  Menu.setApplicationMenu(menu)

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  flushActivityStore()
  stopAllCollabWatchers()
  extensionRegistry?.deactivateAll()
  stopAllRelayServices()
  closeDb()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

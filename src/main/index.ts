import { app, BrowserWindow, ipcMain, shell, Menu, nativeImage, screen } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initWorkspaces, registerWorkspaceIPC, migrateFsScopingIfNeeded, migrateGenerationKeysToKeychain } from './ipc/workspace'
import { registerFsIPC } from './ipc/fs'
import { registerCanvasIPC } from './ipc/canvas'
import { registerTerminalIPC } from './ipc/terminal'
import { startMCPServer, stopMCPServer, setExtensionRegistryProvider } from './mcp-server'
import { registerAgentsIPC } from './ipc/agents'
import { registerStreamIPC } from './ipc/stream'
import { registerGitIPC } from './ipc/git'
import { registerBusIPC } from './ipc/bus'
import { registerChatIPC, killAllChatProcesses } from './ipc/chat'
import { setChatExtensionRegistryProvider } from './chat/provider-registry'
import { registerActivityIPC } from './ipc/activity'
import { registerCollabIPC, stopAllCollabWatchers } from './ipc/collab'
import { registerTileContextIPC } from './ipc/tile-context'
import { registerSystemIPC } from './ipc/system'
import { registerExecutionIPC } from './ipc/execution'
import { registerPermissionsIPC } from './ipc/permissions'
import { getSavedZoomLevel, registerUIIPC } from './ipc/ui'
import { registerJobsIPC } from './ipc/jobs'
import { registerSkillsIPC, queuePendingSkillFile } from './ipc/skills'
import { registerFileProtocol } from './file-protocol'
import { flushAll as flushActivityStore } from './activity-store'
import { runQuitDrains } from './quit-drain.ts'
import { initializeAgentPathsCache, registerAgentPathsIPC } from './agent-paths'
import { ExtensionRegistry } from './extensions/registry'
import { registerExtensionProtocol } from './extensions/protocol'
import { registerExtensionIPC } from './ipc/extensions'
import { registerChromeSyncIPC } from './ipc/chromeSync'
import { registerLocalProxyIPC } from './ipc/localProxy'
import { registerDreamingIPC } from './ipc/dreaming'
import { registerImageIPC } from './ipc/image'
import { registerSpokifyIpc } from './ipc/spokify'
import { registerTtsIpc } from './ipc/tts'
import { registerTranscribeIpc } from './ipc/transcribe'
import { registerSecretsIpc } from './ipc/secrets-ipc'
import { registerMcpConfigIPC } from './ipc/mcp-config'
import { registerOwlIPC } from './ipc/owl'
import { registerWindowIPC } from './ipc/window'
import { registerUpdaterIPC } from './ipc/updater'
import { registerAppearanceIPC } from './ipc/appearance'
import { registerPetsIPC } from './ipc/pets'
import { registerWebviewPaintIPC } from './ipc/webview-paint'
import { applyWindowAppearance, getWindowAppearanceOptions } from './windowAppearance'
import { migrateLegacyStorage } from './migration'
import { APP_ID, APP_NAME } from './paths'
import { closeDb, getDb, getDbStatus } from './db'
import { ensureInitialIndex } from './db/thread-indexer'
import { ensureInitialJobIndex } from './db/job-indexer'
import { unregisterRelayIPC } from './ipc/relay'
import { normalizeSafeExternalUrl } from './utils/externalUrl'
import { log } from './utils/logger.ts'

const indexLog = log.scope('boot')
import {
  attachGuestWebviewSecurityHandlers,
  createMainWindowWebPreferences,
} from './secure-web-preferences'
import { isOwlHostProcess, runOwlHostProcess, stopOwlSupervisor } from './owl/runtime'
import { isBrokerTestProcess, runBrokerTestHost } from './extensions/broker/test-harness'
import {
  createWindowPersistenceBarrierRegistry,
  installAppQuitBarrier,
  type WindowPersistenceReason,
} from './window-persistence-barrier'
import { installElectronPermissionBoundary } from './security/permissionBoundary'

const DEFAULT_MAX_OLD_SPACE_SIZE_MB = 8192
const envMaxOldSpaceSizeMb = Number.parseInt(process.env.CODESURF_MAX_OLD_SPACE_SIZE_MB ?? '', 10)
const maxOldSpaceSizeMb = Number.isFinite(envMaxOldSpaceSizeMb) && envMaxOldSpaceSizeMb > 0
  ? envMaxOldSpaceSizeMb
  : DEFAULT_MAX_OLD_SPACE_SIZE_MB

// Expose global.gc() in renderer processes and keep the Electron V8 flag budget
// aligned with the standalone launcher override.
app.commandLine.appendSwitch('js-flags', `--expose-gc --max-old-space-size=${maxOldSpaceSizeMb}`)

// Prefer the GPU compositor/raster path for the infinite canvas. Electron keeps
// hardware acceleration enabled by default, but these switches help on machines
// where Chromium would otherwise stay conservative about the accelerated path.
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('enable-native-gpu-memory-buffers')
app.commandLine.appendSwitch('ignore-gpu-blocklist')

const isOwlHost = isOwlHostProcess()
const isBrokerTest = isBrokerTestProcess()
const permissionBoundary = installElectronPermissionBoundary({
  developmentRendererUrl: is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined,
  productionRendererFilePath: join(__dirname, '../renderer/index.html'),
})

// .skill file association support -----------------------------------------
// Capture launch-via-Finder / `open "X.skill"` before app.whenReady so the
// path isn't dropped. On macOS Finder uses the `open-file` event; on other
// platforms the path arrives via argv. `queuePendingSkillFile` stashes the
// path and forwards it to the first renderer window once it's ready.
if (!isOwlHost) {
  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    queuePendingSkillFile(filePath)
  })
}

// Single-instance lock so a second `open foo.skill` invocation reuses the
// existing window instead of launching a new one. Argv inspection finds
// `.skill` paths from Windows/Linux file associations (macOS uses open-file).
const gotSingleInstanceLock = isOwlHost
  || isBrokerTest
  || app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else if (!isOwlHost) {
  app.on('second-instance', (_evt, argv) => {
    for (const arg of argv) {
      if (typeof arg === 'string' && arg.toLowerCase().endsWith('.skill')) {
        queuePendingSkillFile(arg)
      }
    }
    const wins = BrowserWindow.getAllWindows()
    if (wins.length > 0) {
      const win = wins[0]
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  // Same argv scan for the first launch — `codesurf foo.skill` from a shell
  // or a double-click on non-mac platforms.
  for (const arg of process.argv.slice(1)) {
    if (typeof arg === 'string' && arg.toLowerCase().endsWith('.skill')) {
      queuePendingSkillFile(arg)
    }
  }
}

// Per-window display titles (webContents.id → label set by renderer via workspace name)
const windowTitles = new Map<number, string>()
const freshWindowIds = new Set<number>()
const miniChatWindows = new Map<string, BrowserWindow>()
const MAIN_WINDOW_TABBING_IDENTIFIER = `${APP_ID}.workspace-tabs`
let extensionRegistry: ExtensionRegistry | null = null
let windowPersistenceBarrierRegistry: ReturnType<
  typeof createWindowPersistenceBarrierRegistry
> | null = null
let disposeAppQuitBarrier: (() => void) | null = null

interface MainWindowOptions {
  fresh?: boolean
  workspaceId?: string | null
  workspacePicker?: boolean
  nativeTabOwner?: BrowserWindow | null
  /** Dev Sandbox: an isolated CodeSurf instance for testing plugins (dashed border). */
  devSandbox?: boolean
}

interface MiniChatWindowRequest {
  workspaceId?: unknown
  tileId?: unknown
  title?: unknown
}

function getMiniChatWindowKey(workspaceId: string, tileId: string): string {
  return `${workspaceId}:${tileId}`
}

function getRendererQuery(params?: Record<string, string>): Record<string, string> | undefined {
  if (!params) return undefined
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value.trim().length > 0))
}

function getMainWindowQuery(opts?: MainWindowOptions): Record<string, string> | undefined {
  const query: Record<string, string> = {}
  const workspaceId = typeof opts?.workspaceId === 'string' ? opts.workspaceId.trim() : ''
  if (workspaceId) query.workspaceId = workspaceId
  if (opts?.workspacePicker) query.workspacePicker = '1'
  if (opts?.devSandbox) query.devSandbox = '1'
  return Object.keys(query).length > 0 ? query : undefined
}

function getFocusedMainWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed() && focused.tabbingIdentifier === MAIN_WINDOW_TABBING_IDENTIFIER) return focused
  return getLiveWindows().find(win => win.tabbingIdentifier === MAIN_WINDOW_TABBING_IDENTIFIER) ?? null
}

function forceMergeNativeWorkspaceTabs(owner: BrowserWindow | null, tab: BrowserWindow): void {
  if (process.platform !== 'darwin') return
  if (!owner || owner.isDestroyed() || owner === tab) return

  const merge = (): void => {
    if (owner.isDestroyed() || tab.isDestroyed()) return
    try {
      owner.mergeAllWindows()
      tab.focus()
    } catch (error) {
      console.warn('[window] Failed to merge native tabs:', error)
    }
  }

  // Electron/AppKit can ignore immediate grouping if the NSWindow is still
  // settling. Retry briefly so a separate window is pulled into the tab group.
  setTimeout(merge, 0)
  setTimeout(merge, 120)
  setTimeout(merge, 400)
}

function addAsNativeWorkspaceTab(owner: BrowserWindow | null, tab: BrowserWindow): boolean {
  if (process.platform !== 'darwin') return false
  if (!owner || owner.isDestroyed() || owner === tab) return false
  if (owner.tabbingIdentifier !== MAIN_WINDOW_TABBING_IDENTIFIER) return false
  try {
    owner.addTabbedWindow(tab)
    forceMergeNativeWorkspaceTabs(owner, tab)
    return true
  } catch (error) {
    console.warn('[window] Failed to attach native tab:', error)
    forceMergeNativeWorkspaceTabs(owner, tab)
    return false
  }
}

function createWorkspaceTab(owner: BrowserWindow | null, opts?: MainWindowOptions): BrowserWindow {
  const win = createWindow({ ...opts, fresh: opts?.fresh ?? true, nativeTabOwner: owner })
  addAsNativeWorkspaceTab(owner, win)
  return win
}

function loadRenderer(win: BrowserWindow, query?: Record<string, string>): void {
  const cleanQuery = getRendererQuery(query)
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    if (cleanQuery) {
      for (const [key, value] of Object.entries(cleanQuery)) url.searchParams.set(key, value)
    }
    win.loadURL(url.toString())
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), cleanQuery ? { query: cleanQuery } : undefined)
  }
}

/**
 * Same-window navigations must never replace the app UI: an external page
 * loaded into a main window would inherit the full preload bridge (fs,
 * terminal, secrets, MCP token). setWindowOpenHandler only covers
 * window.open/target=_blank — will-navigate catches location.href and plain
 * link clicks. External links are handed to the OS handler instead.
 */
function installNavigationGuard(win: BrowserWindow): void {
  win.webContents.on('will-navigate', (event) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (is.dev && devUrl) {
      try {
        if (new URL(event.url).origin === new URL(devUrl).origin) return
      } catch {
        // fall through to deny
      }
    }
    event.preventDefault()
    if (/^https?:\/\//i.test(event.url) || event.url.startsWith('file://')) {
      void openExternalIfSafe(event.url, 'window')
    }
  })
}

function installRenderPerfProbe(win: BrowserWindow): void {
  if (process.env.CODESURF_PERF_RENDER !== '1') return

  const startedAt = performance.now()
  const log = (name: string): void => {
    indexLog.info(`[perf:render] ${name}=${(performance.now() - startedAt).toFixed(1)}ms`)
  }

  win.webContents.once('dom-ready', () => log('domReady'))
  win.once('ready-to-show', () => log('readyToShow'))
  win.webContents.once('did-finish-load', async () => {
    log('didFinishLoad')
    try {
      const metrics = await win.webContents.executeJavaScript(`
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const nav = performance.getEntriesByType('navigation')[0]
            resolve({
              domContentLoaded: nav?.domContentLoadedEventEnd ?? null,
              loadEventEnd: nav?.loadEventEnd ?? null,
              firstPaint: performance.getEntriesByName('first-paint')[0]?.startTime ?? null,
              firstContentfulPaint: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
              twoAnimationFrames: performance.now(),
              nodeCount: document.querySelectorAll('*').length
            })
          }))
        })
      `, true)
      indexLog.info(`[perf:render] rendererMetrics=${JSON.stringify(metrics)}`)
    } catch (error) {
      console.warn('[perf:render] rendererMetrics failed:', error)
    }

    if (process.env.CODESURF_PERF_EXIT_AFTER_RENDER === '1') {
      setTimeout(() => app.quit(), 250)
    }
  })
}

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

/**
 * Catalog directories — extensions scanned from these paths appear in the
 * gallery as available-to-install entries but default to DISABLED so their
 * power-tier main scripts don't execute until the user clicks Add.
 */
function resolveCatalogExtensionDirs(): string[] {
  const candidates = [
    join(app.getAppPath(), 'examples', 'extensions'),
    join(app.getAppPath(), 'resources', 'examples', 'extensions'),
    join(process.resourcesPath, 'examples', 'extensions'),
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
      app.dock?.setIcon(nativeImage.createFromPath(iconPath))
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

function createWindow(opts?: MainWindowOptions): BrowserWindow {
  const iconPath = resolveAppIconPath()
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    // Keep the renderer-drawn toolbar integrated with the macOS traffic lights.
    // A default titlebar adds an extra native strip above our custom workspace tabs.
    show: process.platform === 'darwin' && Boolean(opts?.nativeTabOwner),
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: true,
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 14 } } : {}),
    ...(process.platform === 'darwin' ? { tabbingIdentifier: MAIN_WINDOW_TABBING_IDENTIFIER } : {}),
    ...(iconPath ? { icon: iconPath } : {}),
    ...(process.platform === 'darwin'
      ? { transparent: false, backgroundColor: '#1e1e1e', vibrancy: undefined, visualEffectState: undefined }
      : getWindowAppearanceOptions()),
    webPreferences: createMainWindowWebPreferences(join(__dirname, '../preload/index.js')),
  })
  attachGuestWebviewSecurityHandlers(win.webContents)
  permissionBoundary.registerAppWindow(win)
  const windowId = win.webContents.id
  installRenderPerfProbe(win)
  windowPersistenceBarrierRegistry?.install(win, { role: 'primary-canvas' })

  win.on('ready-to-show', () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    if (process.platform === 'darwin') {
      win.setBackgroundColor('#1e1e1e')
      win.setVibrancy(null)
    } else {
      applyWindowAppearance(win)
    }
    if (!win.getTitle()) win.setTitle(APP_NAME)
    if (!win.isVisible()) win.show()
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
    void openExternalIfSafe(details.url, 'window')
    return { action: 'deny' }
  })
  installNavigationGuard(win)

  // Track fresh windows so renderer can query via IPC
  if (opts?.fresh) {
    freshWindowIds.add(win.webContents.id)
  }

  loadRenderer(win, getMainWindowQuery(opts))

  return win
}

function createMiniChatWindow(owner: BrowserWindow | null, request: MiniChatWindowRequest): { ok: boolean; id?: number; error?: string } {
  const workspaceId = typeof request.workspaceId === 'string' ? request.workspaceId.trim() : ''
  const tileId = typeof request.tileId === 'string' ? request.tileId.trim() : ''
  if (!workspaceId || !tileId) return { ok: false, error: 'workspaceId and tileId are required' }

  const key = getMiniChatWindowKey(workspaceId, tileId)
  const existing = miniChatWindows.get(key)
  if (existing && !existing.isDestroyed() && !existing.webContents.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return { ok: true, id: existing.webContents.id }
  }

  const iconPath = resolveAppIconPath()
  const ownerBounds = owner && !owner.isDestroyed()
    ? owner.getBounds()
    : screen.getPrimaryDisplay().workArea
  const display = screen.getDisplayMatching(ownerBounds)
  const width = 520
  const height = 720
  const x = Math.max(
    display.workArea.x + 12,
    Math.min(ownerBounds.x + ownerBounds.width - width - 28, display.workArea.x + display.workArea.width - width - 12),
  )
  const y = Math.max(
    display.workArea.y + 12,
    Math.min(ownerBounds.y + 68, display.workArea.y + display.workArea.height - height - 12),
  )

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 380,
    minHeight: 420,
    x,
    y,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    ...(iconPath ? { icon: iconPath } : {}),
    ...getWindowAppearanceOptions(),
    webPreferences: createMainWindowWebPreferences(join(__dirname, '../preload/index.js')),
  })
  attachGuestWebviewSecurityHandlers(win.webContents)
  permissionBoundary.registerAppWindow(win)
  windowPersistenceBarrierRegistry?.install(win, { role: 'auxiliary' })

  miniChatWindows.set(key, win)
  windowTitles.set(win.webContents.id, typeof request.title === 'string' && request.title.trim() ? request.title.trim() : 'Mini Chat')

  const closeWithOwner = () => {
    if (!win.isDestroyed()) win.close()
  }
  const hideWithOwner = () => {
    if (!win.isDestroyed()) win.hide()
  }
  const showWithOwner = () => {
    if (!win.isDestroyed()) win.showInactive()
  }
  const liftWithOwner = () => {
    if (!win.isDestroyed() && win.isVisible()) win.moveTop()
  }

  if (owner && !owner.isDestroyed()) {
    owner.once('closed', closeWithOwner)
    owner.on('minimize', hideWithOwner)
    owner.on('restore', showWithOwner)
    owner.on('focus', liftWithOwner)
  }

  win.on('ready-to-show', () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    applyWindowAppearance(win)
    win.show()
    win.focus()
    broadcastWindowList()
  })
  win.on('closed', () => {
    miniChatWindows.delete(key)
    windowTitles.delete(win.webContents.id)
    if (owner && !owner.isDestroyed()) {
      owner.off('closed', closeWithOwner)
      owner.off('minimize', hideWithOwner)
      owner.off('restore', showWithOwner)
      owner.off('focus', liftWithOwner)
    }
    broadcastWindowList()
  })
  win.webContents.setWindowOpenHandler((details) => {
    void openExternalIfSafe(details.url, 'window')
    return { action: 'deny' }
  })
  installNavigationGuard(win)
  win.webContents.on('did-finish-load', async () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    const level = await getSavedZoomLevel()
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.setZoomLevel(level)
  })

  loadRenderer(win, {
    miniChat: '1',
    workspaceId,
    tileId,
    title: typeof request.title === 'string' ? request.title : '',
  })

  return { ok: true, id: win.webContents.id }
}

/**
 * Extensions macOS/Windows hand to an interpreter or launcher rather than a
 * viewer. `shell.openPath` on any of these is arbitrary code execution with the
 * user's privileges, so they are refused regardless of where they live.
 */
export const EXECUTABLE_OPEN_EXTENSIONS = new Set([
  '.command', '.app', '.sh', '.bash', '.zsh', '.fish', '.tool', '.workflow',
  '.scpt', '.scptd', '.applescript', '.osascript', '.action', '.terminal',
  '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.psm1', '.vbs',
  '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.jar', '.pkg', '.dmg',
  '.desktop', '.run', '.bin', '.appimage',
])

export function hasExecutableExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase().replace(/[/\\]+$/, '')
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  return EXECUTABLE_OPEN_EXTENSIONS.has(lower.slice(dot))
}

async function openExternalIfSafe(rawUrl: string, source: 'window' | 'ipc'): Promise<boolean> {
  const trimmed = String(rawUrl ?? '').trim()
  if (trimmed.startsWith('file://')) {
    // Restrict file:// to workspace-scoped paths only — a compromised renderer
    // must not be able to open arbitrary local files via OS default handlers
    // (which can execute .command scripts, launch apps, etc.).
    //
    // `validateFsPath(filePath)` with no options did NOT do this: without
    // `restrictToWorkspaceRoots` assertPathAllowedForFs returns immediately, and
    // anything under CODESURF_HOME short-circuits before even the sensitive-dir
    // denylist. Scope against the real workspace roots, and refuse extensions
    // LaunchServices would execute rather than open.
    let openTarget: string
    try {
      const filePath = fileURLToPath(trimmed)
      if (hasExecutableExtension(filePath)) {
        console.warn(`[shell] Blocked executable file:// from ${source}: ${filePath}`)
        return false
      }
      const { validateCanonicalFsPathDetails } = await import('./ipc/fs')
      const { getAllWorkspaceProjectPaths } = await import('./ipc/workspace')
      const allowedRoots = await getAllWorkspaceProjectPaths()
      const validated = await validateCanonicalFsPathDetails(filePath, 'read', {
        restrictToWorkspaceRoots: true,
        allowedRoots,
      })
      openTarget = validated.operationPath
    } catch (err) {
      console.warn(`[shell] Blocked file:// outside allowed roots from ${source}:`, (err as Error).message)
      return false
    }
    try {
      const errorMessage = await shell.openPath(openTarget)
      if (errorMessage) {
        console.warn(`[shell] Failed to open local file from ${source}: ${errorMessage}`)
        return false
      }
      return true
    } catch (error) {
      console.warn(`[shell] Failed to open local file from ${source}:`, error)
      return false
    }
  }

  const safeUrl = normalizeSafeExternalUrl(rawUrl)
  if (!safeUrl) {
    console.warn(`[shell] Blocked unsafe external URL from ${source}: ${rawUrl}`)
    return false
  }

  try {
    await shell.openExternal(safeUrl)
    return true
  } catch (error) {
    console.warn(`[shell] Failed to open external URL from ${source}:`, error)
    return false
  }
}

if (isOwlHost) {
  void runOwlHostProcess().catch(error => {
    console.error('[owl-host] failed to start:', error)
    app.quit()
  })
} else if (isBrokerTest) {
  void runBrokerTestHost().catch(error => {
    console.error('[broker-test] failed to start:', error)
    app.quit()
  })
} else {
app.whenReady().then(async () => {
  applyRuntimeAppBranding()
  electronApp.setAppUserModelId(APP_ID)
  windowPersistenceBarrierRegistry = createWindowPersistenceBarrierRegistry(ipcMain)

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
    indexLog.info(`[db] Ready at ${status.path} (schema v${status.schemaVersion}, tables: ${status.tables.join(', ') || '—'})`)
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

  // Same pattern for the job + timeline index.
  void ensureInitialJobIndex().catch(err => {
    // eslint-disable-next-line no-console
    console.warn('[jobs] initial index failed:', err)
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
  registerJobsIPC()
  registerSkillsIPC()
  registerDreamingIPC()
  registerImageIPC()
  registerSpokifyIpc()
  registerTtsIpc()
  registerTranscribeIpc()
  registerSecretsIpc()
  registerMcpConfigIPC()
  registerOwlIPC()
  registerWebviewPaintIPC()
  registerFileProtocol()
  registerAgentPathsIPC()
  registerChromeSyncIPC()
  registerLocalProxyIPC()

  // gap-03: migrate any pre-existing plaintext generation keys into the keychain
  // in the background (idempotent; never blocks boot).
  void migrateGenerationKeysToKeychain()
  void migrateFsScopingIfNeeded()

  // Keep the extension system fully lazy. Do not scan or boot extension hosts
  // at startup; load them only when an extension tile or explicit management UI asks.
  extensionRegistry = new ExtensionRegistry({
    bundledDirs: resolveBundledExtensionDirs(),
    catalogDirs: resolveCatalogExtensionDirs(),
    onSensitiveMediaRevoked: extensionId => {
      return permissionBoundary.revokeExtensionMedia(extensionId)
    },
  })
  permissionBoundary.setExtensionAuthorizer({
    getExtensionMediaPermission: extensionId => {
      return extensionRegistry?.getExtensionMediaPermission(extensionId)
    },
  })
  registerExtensionProtocol(extensionRegistry)
  registerExtensionIPC(extensionRegistry)
  setExtensionRegistryProvider(() => extensionRegistry)
  setChatExtensionRegistryProvider(() => extensionRegistry)

  registerAppearanceIPC()
  registerPetsIPC()

  // Prime cached agent paths from disk only. Full binary detection is deferred
  // until setup/manual refresh so startup does not shell out across all agents.
  await initializeAgentPathsCache().catch(err => {
    console.error('[AgentPaths] Cache init failed:', err)
    return null
  })

  // Start local MCP server for agent→kanban callbacks
  startMCPServer().then(port => {
    indexLog.info(`[MCP] Kanban tools available at http://127.0.0.1:${port}`)
  }).catch(err => console.error('[MCP] Failed to start:', err))
  registerUpdaterIPC()
  registerWindowIPC({
    createWindow,
    createWorkspaceTab,
    createMiniChatWindow,
    getFocusedMainWindow,
    getLiveWindows,
    windowTitles,
    freshWindowIds,
    broadcastWindowList,
    openExternalIfSafe,
  })

  const reloadFocusedWindow = (
    reason: Extract<WindowPersistenceReason, 'reload' | 'force-reload'>,
  ): void => {
    const win = BrowserWindow.getFocusedWindow() ?? getFocusedMainWindow()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    const persistence = windowPersistenceBarrierRegistry?.requestPersistence(win, reason)
      ?? Promise.resolve()
    void persistence
      .catch(error => {
        console.error(`[window] ${reason} persistence challenge failed:`, error)
      })
      .then(() => {
        if (win.isDestroyed() || win.webContents.isDestroyed()) return
        if (reason === 'force-reload') {
          win.webContents.reloadIgnoringCache()
        } else {
          win.webContents.reload()
        }
      })
  }

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
            const win = getFocusedMainWindow()
            if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
              win.webContents.send('workspace:newTab')
              return
            }
            if (process.platform === 'darwin') {
              createWorkspaceTab(null, { fresh: true, workspacePicker: true })
            } else {
              createWindow({ fresh: true })
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
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => reloadFocusedWindow('reload'),
        },
        {
          label: 'Force Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => reloadFocusedWindow('force-reload'),
        },
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

  app.on('new-window-for-tab', () => {
    const owner = getFocusedMainWindow()
    if (process.platform === 'darwin') {
      createWorkspaceTab(owner, { fresh: true, workspacePicker: true })
    } else {
      createWindow({ fresh: true })
    }
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
}

async function runAppShutdownCleanup(): Promise<void> {
  // The app quit barrier has already settled every window/canvas challenge in
  // deterministic ownership order. Join main-process persistence here rather
  // than registering a competing before-quit listener.
  await runQuitDrains({
    drains: [{ name: 'activity', run: flushActivityStore }],
    timeoutMs: 5_000,
    onFailure: failure => indexLog.warn(
      'quit drain continued after bounded failure',
      failure,
    ),
  })
  const mcpShutdown = stopMCPServer()
  const relayShutdown = unregisterRelayIPC()
  const chatShutdown = killAllChatProcesses()
  stopAllCollabWatchers()
  extensionRegistry?.deactivateAll()
  stopOwlSupervisor()
  closeDb()
  const [mcpResult, relayResult, chatResult] = await Promise.allSettled([
    mcpShutdown,
    relayShutdown,
    chatShutdown,
  ])
  if (mcpResult.status === 'rejected') {
    console.warn(
      '[MCP] Failed to stop local server during shutdown:',
      mcpResult.reason,
    )
  }
  if (relayResult.status === 'rejected') {
    console.warn(
      '[Relay] Failed to stop relay providers during shutdown:',
      relayResult.reason,
    )
    throw relayResult.reason
  }
  if (chatResult.status === 'rejected') {
    console.warn(
      '[Chat] Failed to confirm chat process shutdown:',
      chatResult.reason,
    )
    throw chatResult.reason
  }
}

disposeAppQuitBarrier = installAppQuitBarrier(
  app,
  () => windowPersistenceBarrierRegistry,
  runAppShutdownCleanup,
)

app.on('will-quit', () => {
  disposeAppQuitBarrier?.()
  disposeAppQuitBarrier = null
  windowPersistenceBarrierRegistry?.dispose()
  windowPersistenceBarrierRegistry = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

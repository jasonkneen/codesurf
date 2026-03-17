import { app, BrowserWindow, shell, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initWorkspaces, registerWorkspaceIPC } from './ipc/workspace'
import { registerFsIPC } from './ipc/fs'
import { registerCanvasIPC } from './ipc/canvas'
import { registerTerminalIPC } from './ipc/terminal'
import { startMCPServer, getMCPPort } from './mcp-server'
import { registerAgentsIPC } from './ipc/agents'
import { registerStreamIPC } from './ipc/stream'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.vibeclaw.collaborator')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Init workspace dirs + register all IPC handlers
  await initWorkspaces()
  registerWorkspaceIPC()
  registerFsIPC()
  registerCanvasIPC()
  registerTerminalIPC()
  registerAgentsIPC()
  registerStreamIPC()

  // Start local MCP server for agent→kanban callbacks
  startMCPServer().then(port => {
    console.log(`[MCP] Kanban tools available at http://127.0.0.1:${port}`)
  }).catch(err => console.error('[MCP] Failed to start:', err))

  // Expose MCP port to renderer
  ipcMain.handle('mcp:getPort', () => getMCPPort())

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

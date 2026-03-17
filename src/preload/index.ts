import { contextBridge, ipcRenderer } from 'electron'

// Expose IPC bridges to the renderer
contextBridge.exposeInMainWorld('electron', {
  // Workspace operations
  workspace: {
    list: () => ipcRenderer.invoke('workspace:list'),
    create: (name: string) => ipcRenderer.invoke('workspace:create', name),
    delete: (id: string) => ipcRenderer.invoke('workspace:delete', id),
    setActive: (id: string) => ipcRenderer.invoke('workspace:setActive', id),
    getActive: () => ipcRenderer.invoke('workspace:getActive')
  },

  // File system operations
  fs: {
    readDir: (path: string) => ipcRenderer.invoke('fs:readDir', path),
    readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),
    writeFile: (path: string, content: string) => ipcRenderer.invoke('fs:writeFile', path, content),
    createFile: (path: string) => ipcRenderer.invoke('fs:createFile', path),
    deleteFile: (path: string) => ipcRenderer.invoke('fs:deleteFile', path),
    renameFile: (oldPath: string, newPath: string) => ipcRenderer.invoke('fs:renameFile', oldPath, newPath),
    watch: (path: string, callback: (event: string, filename: string) => void) => {
      const channel = `fs:watch:${path}`
      ipcRenderer.on(channel, (_, event, filename) => callback(event, filename))
      return () => ipcRenderer.removeAllListeners(channel)
    },
    revealInFinder: (path: string) => ipcRenderer.invoke('fs:revealInFinder', path),
    writeBrief: (cardId: string, content: string) => ipcRenderer.invoke('fs:writeBrief', cardId, content)
  },

  // Canvas state persistence
  canvas: {
    load: (workspaceId: string) => ipcRenderer.invoke('canvas:load', workspaceId),
    save: (workspaceId: string, state: any) => ipcRenderer.invoke('canvas:save', workspaceId, state)
  },

  // Terminal operations (stub for now)
  terminal: {
    create: (tileId: string, workspaceDir: string, launchBin?: string, launchArgs?: string[]) => ipcRenderer.invoke('terminal:create', tileId, workspaceDir, launchBin, launchArgs),
    write: (tileId: string, data: string) => ipcRenderer.invoke('terminal:write', tileId, data),
    resize: (tileId: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', tileId, cols, rows),
    destroy: (tileId: string) => ipcRenderer.invoke('terminal:destroy', tileId),
    onData: (tileId: string, callback: (data: string) => void) => {
      const channel = `terminal:data:${tileId}`
      ipcRenderer.on(channel, (_, data) => callback(data))
      return () => ipcRenderer.removeAllListeners(channel)
    },
    onActive: (tileId: string, callback: () => void) => {
      const channel = `terminal:active:${tileId}`
      ipcRenderer.on(channel, () => callback())
      return () => ipcRenderer.removeAllListeners(channel)
    }
  },

  // Agent detection
  agents: {
    detect: () => ipcRenderer.invoke('agents:detect')
  },

  // Agent streaming (SSE/NDJSON parsers for Claude, Codex, Pi)
  stream: {
    start: (req: { cardId: string; agentId: string; url: string; method?: string; headers?: Record<string, string>; body?: string }) =>
      ipcRenderer.invoke('stream:start', req),
    stop: (cardId: string) => ipcRenderer.invoke('stream:stop', cardId),
    onChunk: (cb: (event: { cardId: string; type: string; text?: string; toolName?: string; error?: string }) => void) => {
      ipcRenderer.on('agent:stream', (_, evt) => cb(evt))
      return () => ipcRenderer.removeAllListeners('agent:stream')
    }
  },

  // Update checker (stub)
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download')
  },

  // MCP server
  mcp: {
    getPort: () => ipcRenderer.invoke('mcp:getPort'),
    onKanban: (cb: (event: string, data: unknown) => void) => {
      ipcRenderer.on('mcp:kanban', (_, payload) => cb(payload.event, payload.data))
      return () => ipcRenderer.removeAllListeners('mcp:kanban')
    },
    onInject: (cb: (cardId: string, message: string, appendNewline: boolean) => void) => {
      ipcRenderer.on('mcp:inject', (_, payload) => cb(payload.cardId, payload.message, payload.appendNewline))
      return () => ipcRenderer.removeAllListeners('mcp:inject')
    },
    inject: (cardId: string, message: string) => ipcRenderer.invoke('terminal:write', cardId, message + '\r')
  }
})

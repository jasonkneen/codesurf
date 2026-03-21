import { contextBridge, ipcRenderer } from 'electron'

function channelMatches(pattern: string, channel: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith(':*')) return channel.startsWith(pattern.slice(0, -1))
  return pattern === channel
}

// Expose IPC bridges to the renderer
contextBridge.exposeInMainWorld('electron', {
  // Workspace operations
  workspace: {
    list: () => ipcRenderer.invoke('workspace:list'),
    create: (name: string) => ipcRenderer.invoke('workspace:create', name),
    createFromFolder: (folderPath: string) => ipcRenderer.invoke('workspace:createFromFolder', folderPath),
    openFolder: () => ipcRenderer.invoke('workspace:openFolder'),
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
    createDir: (path: string) => ipcRenderer.invoke('fs:createDir', path),
    deleteFile: (path: string) => ipcRenderer.invoke('fs:deleteFile', path),
    renameFile: (oldPath: string, newPath: string) => ipcRenderer.invoke('fs:renameFile', oldPath, newPath),
    watch: (dirPath: string, callback: () => void) => {
      const channel = `fs:watch:${dirPath}`
      const handler = () => callback()
      ipcRenderer.on(channel, handler)
      ipcRenderer.invoke('fs:watchStart', dirPath)
      return () => {
        ipcRenderer.removeListener(channel, handler)
        ipcRenderer.invoke('fs:watchStop', dirPath)
      }
    },
    revealInFinder: (path: string) => ipcRenderer.invoke('fs:revealInFinder', path),
    writeBrief: (cardId: string, content: string) => ipcRenderer.invoke('fs:writeBrief', cardId, content),
    stat: (path: string) => ipcRenderer.invoke('fs:stat', path),
    copyIntoDir: (sourcePath: string, destDir: string) => ipcRenderer.invoke('fs:copyIntoDir', sourcePath, destDir)
  },

  // Canvas state persistence
  canvas: {
    load: (workspaceId: string) => ipcRenderer.invoke('canvas:load', workspaceId),
    save: (workspaceId: string, state: any) => ipcRenderer.invoke('canvas:save', workspaceId, state),
    loadTileState: (workspaceId: string, tileId: string) => ipcRenderer.invoke('canvas:loadTileState', workspaceId, tileId),
    saveTileState: (workspaceId: string, tileId: string, state: any) => ipcRenderer.invoke('canvas:saveTileState', workspaceId, tileId, state),
    clearTileState: (workspaceId: string, tileId: string) => ipcRenderer.invoke('canvas:clearTileState', workspaceId, tileId),
    deleteTileArtifacts: (workspaceId: string, tileId: string) => ipcRenderer.invoke('canvas:deleteTileArtifacts', workspaceId, tileId)
  },

  // Kanban board state persistence
  kanban: {
    load: (workspaceId: string, tileId: string) => ipcRenderer.invoke('kanban:load', workspaceId, tileId),
    save: (workspaceId: string, tileId: string, state: any) => ipcRenderer.invoke('kanban:save', workspaceId, tileId, state)
  },

  // Terminal operations (stub for now)
  terminal: {
    create: (tileId: string, workspaceDir: string, launchBin?: string, launchArgs?: string[]) => ipcRenderer.invoke('terminal:create', tileId, workspaceDir, launchBin, launchArgs),
    write: (tileId: string, data: string) => ipcRenderer.invoke('terminal:write', tileId, data),
    resize: (tileId: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', tileId, cols, rows),
    destroy: (tileId: string) => ipcRenderer.invoke('terminal:destroy', tileId),
    onData: (tileId: string, callback: (data: string) => void) => {
      const channel = `terminal:data:${tileId}`
      const handler = (_: any, data: string) => callback(data)
      ipcRenderer.on(channel, handler)
      return () => { ipcRenderer.removeListener(channel, handler) }
    },
    onActive: (tileId: string, callback: () => void) => {
      const channel = `terminal:active:${tileId}`
      const handler = () => callback()
      ipcRenderer.on(channel, handler)
      return () => { ipcRenderer.removeListener(channel, handler) }
    }
  },

  // Agent detection
  agents: {
    detect: () => ipcRenderer.invoke('agents:detect')
  },

  // Chat — send messages to LLM providers (Claude, Codex, OpenCode)
  chat: {
    send: (req: { cardId: string; provider: string; model: string; messages: { role: string; content: string }[] }) =>
      ipcRenderer.invoke('chat:send', req),
    stop: (cardId: string) => ipcRenderer.invoke('chat:stop', cardId),
    clearSession: (cardId: string) => ipcRenderer.invoke('chat:clearSession', cardId),
    opencodeModels: () => ipcRenderer.invoke('chat:opencodeModels'),
  },

  // Agent streaming (SSE/NDJSON parsers for Claude, Codex, Pi)
  stream: {
    start: (req: { cardId: string; agentId: string; url: string; method?: string; headers?: Record<string, string>; body?: string }) =>
      ipcRenderer.invoke('stream:start', req),
    stop: (cardId: string) => ipcRenderer.invoke('stream:stop', cardId),
    onChunk: (cb: (event: { cardId: string; type: string; text?: string; toolName?: string; error?: string }) => void) => {
      const handler = (_: any, evt: { cardId: string; type: string; text?: string; toolName?: string; error?: string }) => cb(evt)
      ipcRenderer.on('agent:stream', handler)
      return () => { ipcRenderer.removeListener('agent:stream', handler) }
    }
  },

  // Git
  git: {
    status: (dirPath: string) => ipcRenderer.invoke('git:status', dirPath),
  },

  // Window management
  window: {
    new: () => ipcRenderer.invoke('window:new'),
    newTab: () => ipcRenderer.invoke('window:newTab'),
    list: () => ipcRenderer.invoke('window:list'),
    getCurrentId: () => ipcRenderer.invoke('window:getCurrentId'),
    setTitle: (title: string) => ipcRenderer.invoke('window:setTitle', title),
    focusById: (id: number) => ipcRenderer.invoke('window:focusById', id),
    closeById: (id: number) => ipcRenderer.invoke('window:closeById', id),
    onListChanged: (cb: (list: { id: number; title: string; focused: boolean }[]) => void) => {
      const handler = (_: unknown, list: { id: number; title: string; focused: boolean }[]) => cb(list)
      ipcRenderer.on('window:list-changed', handler)
      return () => ipcRenderer.off('window:list-changed', handler)
    },
  },

  app: {
    relaunch: () => ipcRenderer.invoke('app:relaunch')
  },

  browserTile: {
    sync: (payload: { tileId: string; url: string; mode: 'desktop' | 'mobile'; zIndex: number; visible: boolean; bounds: { left: number; top: number; width: number; height: number } }) =>
      ipcRenderer.invoke('browserTile:sync', payload),
    command: (payload: { tileId: string; command: 'back' | 'forward' | 'reload' | 'stop' | 'home' | 'navigate' | 'mode'; url?: string; mode?: 'desktop' | 'mobile' }) =>
      ipcRenderer.invoke('browserTile:command', payload),
    destroy: (tileId: string) => ipcRenderer.invoke('browserTile:destroy', tileId),
    onEvent: (cb: (event: { tileId: string; currentUrl: string; canGoBack: boolean; canGoForward: boolean; isLoading: boolean; mode: 'desktop' | 'mobile' }) => void) => {
      const handler = (_: any, evt: { tileId: string; currentUrl: string; canGoBack: boolean; canGoForward: boolean; isLoading: boolean; mode: 'desktop' | 'mobile' }) => cb(evt)
      ipcRenderer.on('browserTile:event', handler)
      return () => { ipcRenderer.removeListener('browserTile:event', handler) }
    }
  },

  // App settings
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (settings: any) => ipcRenderer.invoke('settings:set', settings),
    getRawJson: () => ipcRenderer.invoke('settings:getRawJson'),
    setRawJson: (json: string) => ipcRenderer.invoke('settings:setRawJson', json),
  },

  // Update checker
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    quitAndInstall: () => ipcRenderer.invoke('updater:quitAndInstall')
  },

  // MCP server
  mcp: {
    getPort: () => ipcRenderer.invoke('mcp:getPort'),
    getConfig: () => ipcRenderer.invoke('mcp:getConfig'),
    saveServers: (servers: Record<string, unknown>) => ipcRenderer.invoke('mcp:saveServers', servers),
    getWorkspaceServers: (workspaceId: string) => ipcRenderer.invoke('mcp:getWorkspaceServers', workspaceId),
    saveWorkspaceServers: (workspaceId: string, servers: Record<string, unknown>) => ipcRenderer.invoke('mcp:saveWorkspaceServers', workspaceId, servers),
    getMergedConfig: (workspaceId: string) => ipcRenderer.invoke('mcp:getMergedConfig', workspaceId),
    onKanban: (cb: (event: string, data: unknown) => void) => {
      const handler = (_: any, payload: any) => cb(payload.event, payload.data)
      ipcRenderer.on('mcp:kanban', handler)
      return () => { ipcRenderer.removeListener('mcp:kanban', handler) }
    },
    onInject: (cb: (cardId: string, message: string, appendNewline: boolean) => void) => {
      const handler = (_: any, payload: any) => cb(payload.cardId, payload.message, payload.appendNewline)
      ipcRenderer.on('mcp:inject', handler)
      return () => { ipcRenderer.removeListener('mcp:inject', handler) }
    },
    inject: (cardId: string, message: string) => ipcRenderer.invoke('terminal:write', cardId, message + '\r')
  },

  // Activity store (persisted per-workspace)
  activity: {
    upsert: (workspaceId: string, data: {
      id?: string
      tileId: string
      type: 'task' | 'tool' | 'skill' | 'context'
      status?: 'pending' | 'running' | 'done' | 'error' | 'paused'
      title: string
      detail?: string
      metadata?: Record<string, unknown>
      agent?: string
    }) => ipcRenderer.invoke('activity:upsert', workspaceId, data),
    query: (query: {
      workspaceId: string
      tileId?: string
      type?: string
      status?: string
      agent?: string
      limit?: number
    }) => ipcRenderer.invoke('activity:query', query),
    byTile: (workspaceId: string, tileId: string) => ipcRenderer.invoke('activity:byTile', workspaceId, tileId),
    delete: (workspaceId: string, id: string) => ipcRenderer.invoke('activity:delete', workspaceId, id),
    clearTile: (workspaceId: string, tileId: string) => ipcRenderer.invoke('activity:clearTile', workspaceId, tileId),
    byAgent: (workspaceId: string) => ipcRenderer.invoke('activity:byAgent', workspaceId),
  },

  // Contex protocol (.contex folder)
  collab: {
    ensureDir: (workspacePath: string, tileId: string) => ipcRenderer.invoke('collab:ensureDir', workspacePath, tileId),
    writeObjective: (workspacePath: string, tileId: string, md: string) => ipcRenderer.invoke('collab:writeObjective', workspacePath, tileId, md),
    readObjective: (workspacePath: string, tileId: string) => ipcRenderer.invoke('collab:readObjective', workspacePath, tileId),
    writeSkills: (workspacePath: string, tileId: string, skills: { enabled: string[], disabled: string[] }) => ipcRenderer.invoke('collab:writeSkills', workspacePath, tileId, skills),
    readSkills: (workspacePath: string, tileId: string) => ipcRenderer.invoke('collab:readSkills', workspacePath, tileId),
    writeState: (workspacePath: string, tileId: string, state: any) => ipcRenderer.invoke('collab:writeState', workspacePath, tileId, state),
    readState: (workspacePath: string, tileId: string) => ipcRenderer.invoke('collab:readState', workspacePath, tileId),
    addContext: (workspacePath: string, tileId: string, filename: string, content: string) => ipcRenderer.invoke('collab:addContext', workspacePath, tileId, filename, content),
    removeContext: (workspacePath: string, tileId: string, filename: string) => ipcRenderer.invoke('collab:removeContext', workspacePath, tileId, filename),
    listContext: (workspacePath: string, tileId: string) => ipcRenderer.invoke('collab:listContext', workspacePath, tileId),
    readContext: (workspacePath: string, tileId: string, filename: string) => ipcRenderer.invoke('collab:readContext', workspacePath, tileId, filename),
    watchState: (workspacePath: string, tileId: string) => ipcRenderer.invoke('collab:watchState', workspacePath, tileId),
    unwatchState: (workspacePath: string, tileId: string) => ipcRenderer.invoke('collab:unwatchState', workspacePath, tileId),
    removeTileDir: (workspacePath: string, tileId: string) => ipcRenderer.invoke('collab:removeTileDir', workspacePath, tileId),
    pruneOrphanedTileDirs: (workspacePath: string, tileIds: string[]) => ipcRenderer.invoke('collab:pruneOrphanedTileDirs', workspacePath, tileIds),
    onStateChanged: (callback: (data: { workspacePath: string, tileId: string, state: any }) => void) => {
      const handler = (_: any, data: { workspacePath: string, tileId: string, state: any }) => callback(data)
      ipcRenderer.on('collab:stateChanged', handler)
      return () => { ipcRenderer.removeListener('collab:stateChanged', handler) }
    },
  },

  // Event bus
  bus: {
    publish: (channel: string, type: string, source: string, payload: Record<string, unknown>) =>
      ipcRenderer.invoke('bus:publish', channel, type, source, payload),
    subscribe: (channel: string, subscriberId: string, callback: (event: any) => void) => {
      ipcRenderer.invoke('bus:subscribe', channel, subscriberId)
      const handler = (_: any, evt: any) => {
        if (evt.channel === channel || channelMatches(channel, evt.channel)) callback(evt)
      }
      ipcRenderer.on('bus:event', handler)
      return () => {
        ipcRenderer.removeListener('bus:event', handler)
        ipcRenderer.invoke('bus:unsubscribeAll', subscriberId)
      }
    },
    unsubscribeAll: (subscriberId: string) => ipcRenderer.invoke('bus:unsubscribeAll', subscriberId),
    history: (channel: string, limit?: number) => ipcRenderer.invoke('bus:history', channel, limit),
    channelInfo: (channel: string) => ipcRenderer.invoke('bus:channelInfo', channel),
    unreadCount: (channel: string, subscriberId: string) => ipcRenderer.invoke('bus:unreadCount', channel, subscriberId),
    markRead: (channel: string, subscriberId: string) => ipcRenderer.invoke('bus:markRead', channel, subscriberId),
    onEvent: (callback: (event: any) => void) => {
      const handler = (_: any, evt: any) => callback(evt)
      ipcRenderer.on('bus:event', handler)
      return () => ipcRenderer.removeListener('bus:event', handler)
    }
  }
})

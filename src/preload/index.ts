import { contextBridge, ipcRenderer, webUtils, webFrame } from 'electron'
import { homedir } from 'os'
import type { AggregatedSessionEntry } from '../shared/session-types'

function channelMatches(pattern: string, channel: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith(':*')) return channel.startsWith(pattern.slice(0, -1))
  return pattern === channel
}

// Expose IPC bridges to the renderer
contextBridge.exposeInMainWorld('electron', {
  // OS dark/light (Electron nativeTheme) — used when appearance is "system"
  appearance: {
    shouldUseDark: () => ipcRenderer.invoke('appearance:shouldUseDark'),
    setThemeSource: (mode: 'dark' | 'light' | 'system') => ipcRenderer.invoke('appearance:setThemeSource', mode),
    onUpdated: (callback: (payload: { shouldUseDark: boolean }) => void) => {
      const handler = (_: unknown, payload: { shouldUseDark: boolean }) => callback(payload)
      ipcRenderer.on('appearance:updated', handler)
      return () => { ipcRenderer.removeListener('appearance:updated', handler) }
    },
  },

  // Workspace operations
  workspace: {
    list: () => ipcRenderer.invoke('workspace:list'),
    listProjects: () => ipcRenderer.invoke('workspace:listProjects'),
    create: (name: string) => ipcRenderer.invoke('workspace:create', name),
    createWithPath: (name: string, projectPath: string) => ipcRenderer.invoke('workspace:createWithPath', name, projectPath),
    createFromFolder: (folderPath: string) => ipcRenderer.invoke('workspace:createFromFolder', folderPath),
    addProjectFolder: (workspaceId: string, folderPath: string) => ipcRenderer.invoke('workspace:addProjectFolder', workspaceId, folderPath),
    removeProjectFolder: (workspaceId: string, folderPath: string) => ipcRenderer.invoke('workspace:removeProjectFolder', workspaceId, folderPath),
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
    isProbablyTextFile: (path: string) => ipcRenderer.invoke('fs:isProbablyTextFile', path),
    copyIntoDir: (sourcePath: string, destDir: string) => ipcRenderer.invoke('fs:copyIntoDir', sourcePath, destDir),
    selectDir: () => ipcRenderer.invoke('workspace:openFolder'),
  },

  // Tile context (ctx: key-value store)
  tileContext: {
    get: (workspaceId: string, tileId: string, key?: string) => ipcRenderer.invoke('tileContext:get', workspaceId, tileId, key),
    getAll: (workspaceId: string, tileId: string, tagPrefix?: string) => ipcRenderer.invoke('tileContext:getAll', workspaceId, tileId, tagPrefix),
    set: (workspaceId: string, tileId: string, key: string, value: unknown) => ipcRenderer.invoke('tileContext:set', workspaceId, tileId, key, value),
    delete: (workspaceId: string, tileId: string, key: string) => ipcRenderer.invoke('tileContext:delete', workspaceId, tileId, key),
    onChanged: (tileId: string, callback: (data: { tileId: string; key: string; value: unknown }) => void) => {
      const handler = (_: any, data: any) => { if (data.tileId === tileId) callback(data) }
      ipcRenderer.on('tileContext:changed', handler)
      return () => ipcRenderer.removeListener('tileContext:changed', handler)
    },
  },

  // Extension action IPC
  extActions: {
    onAction: (callback: (data: { tileId: string; action: string; params: Record<string, unknown> }) => void) => {
      const handler = (_: any, data: any) => callback(data)
      ipcRenderer.on('ext:action', handler)
      return () => ipcRenderer.removeListener('ext:action', handler)
    },
  },

  // Canvas state persistence
  canvas: {
    load: (workspaceId: string) => ipcRenderer.invoke('canvas:load', workspaceId),
    save: (workspaceId: string, state: any) => ipcRenderer.invoke('canvas:save', workspaceId, state),
    loadTileState: (workspaceId: string, tileId: string) => ipcRenderer.invoke('canvas:loadTileState', workspaceId, tileId),
    saveTileState: (workspaceId: string, tileId: string, state: any) => ipcRenderer.invoke('canvas:saveTileState', workspaceId, tileId, state),
    clearTileState: (workspaceId: string, tileId: string) => ipcRenderer.invoke('canvas:clearTileState', workspaceId, tileId),
    deleteTileArtifacts: (workspaceId: string, tileId: string) => ipcRenderer.invoke('canvas:deleteTileArtifacts', workspaceId, tileId),
    listSessions: (workspaceId: string, forceRefresh?: boolean) => ipcRenderer.invoke('canvas:listSessions', workspaceId, forceRefresh === true) as Promise<AggregatedSessionEntry[]>,
    onSessionsChanged: (cb: (payload: { workspaceId: string }) => void) => {
      const handler = (_: unknown, payload: { workspaceId: string }) => cb(payload)
      ipcRenderer.on('canvas:sessionsChanged', handler)
      return () => ipcRenderer.removeListener('canvas:sessionsChanged', handler)
    },
    getSessionState: (workspaceId: string, sessionEntryId: string) => ipcRenderer.invoke('canvas:getSessionState', workspaceId, sessionEntryId),
    deleteSession: (workspaceId: string, sessionEntryId: string) => ipcRenderer.invoke('canvas:deleteSession', workspaceId, sessionEntryId),
    renameSession: (workspaceId: string, sessionEntryId: string, title: string) => ipcRenderer.invoke('canvas:renameSession', workspaceId, sessionEntryId, title),
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
    cd: (tileId: string, dirPath: string) => ipcRenderer.invoke('terminal:cd', tileId, dirPath),
    resize: (tileId: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', tileId, cols, rows),
    destroy: (tileId: string) => ipcRenderer.invoke('terminal:destroy', tileId),
    detach: (tileId: string) => ipcRenderer.invoke('terminal:detach', tileId),
    updatePeers: (tileId: string, workspaceDir: string, peers: Array<{ peerId: string; peerType: string; tools: string[] }>) => ipcRenderer.invoke('terminal:update-peers', tileId, workspaceDir, peers),
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

  // Agent binary paths (startup detection + confirmation)
  agentPaths: {
    get: () => ipcRenderer.invoke('agentPaths:get'),
    detect: () => ipcRenderer.invoke('agentPaths:detect'),
    set: (agentId: string, path: string | null) => ipcRenderer.invoke('agentPaths:set', agentId, path),
    needsSetup: () => ipcRenderer.invoke('agentPaths:needsSetup'),
    confirmAll: () => ipcRenderer.invoke('agentPaths:confirmAll'),
  },

  // Chat — send messages to LLM providers (Claude, Codex, OpenCode, OpenClaw, Hermes)
  chat: {
    send: (req: {
      cardId: string
      provider: string
      model: string
      messages: { role: string; content: string }[]
      runMode?: 'foreground' | 'background'
      negotiatedTools?: string[]
      peers?: { peerId: string; peerType: string; tools: string[] }[]
      providerTransport?: import('../shared/types').ExtensionChatTransportConfig | null
    }) =>
      ipcRenderer.invoke('chat:send', req),
    resumeJob: (req: {
      cardId: string
      provider: string
      model: string
      workspaceDir?: string
      executionTarget?: 'local' | 'cloud'
      cloudHostId?: string | null
      executionPreference?: import('../shared/types').ExecutionPreference | null
      jobId?: string | null
      jobSequence?: number
    }) => ipcRenderer.invoke('chat:resumeJob', req),
    stop: (cardId: string) => ipcRenderer.invoke('chat:stop', cardId),
    clearSession: (cardId: string) => ipcRenderer.invoke('chat:clearSession', cardId),
    opencodeModels: () => ipcRenderer.invoke('chat:opencodeModels'),
    onOpencodeModelsUpdated: (cb: (payload: { models: Array<{ id: string; label: string; description?: string }>; source: string; error?: string }) => void) => {
      const handler = (_: unknown, payload: { models: Array<{ id: string; label: string; description?: string }>; source: string; error?: string }) => cb(payload)
      ipcRenderer.on('chat:opencodeModelsUpdated', handler)
      return () => ipcRenderer.removeListener('chat:opencodeModelsUpdated', handler)
    },
    openclawAgents: () => ipcRenderer.invoke('chat:openclawAgents'),
    selectFiles: () => ipcRenderer.invoke('chat:selectFiles') as Promise<string[]>,
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
    branches: (dirPath: string) => ipcRenderer.invoke('git:branches', dirPath),
    checkoutBranch: (dirPath: string, branchName: string) => ipcRenderer.invoke('git:checkoutBranch', dirPath, branchName),
    createBranch: (dirPath: string, branchName: string) => ipcRenderer.invoke('git:createBranch', dirPath, branchName),
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
    setSidebarCollapsed: (collapsed: boolean) => ipcRenderer.invoke('window:setSidebarCollapsed', collapsed),
    onListChanged: (cb: (list: { id: number; title: string; focused: boolean }[]) => void) => {
      const handler = (_: unknown, list: { id: number; title: string; focused: boolean }[]) => cb(list)
      ipcRenderer.on('window:list-changed', handler)
      return () => ipcRenderer.off('window:list-changed', handler)
    },
    isFresh: () => ipcRenderer.invoke('window:isFresh'),
    onNewTab: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('workspace:newTab', handler)
      return () => ipcRenderer.removeListener('workspace:newTab', handler)
    },
  },

  app: {
    relaunch: () => ipcRenderer.invoke('app:relaunch')
  },

  execution: {
    listHosts: () => ipcRenderer.invoke('execution:listHosts'),
    upsertHost: (host: import('../shared/types').ExecutionHostRecord) => ipcRenderer.invoke('execution:upsertHost', host),
    deleteHost: (id: string) => ipcRenderer.invoke('execution:deleteHost', id),
    resolveTarget: (preference: import('../shared/types').ExecutionPreference) => ipcRenderer.invoke('execution:resolveTarget', preference),
  },

  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
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

  // Chrome data sync
  chromeSync: {
    listProfiles: () => ipcRenderer.invoke('chromeSync:listProfiles'),
    getStatus: (settings: { enabled: boolean; profileDir: string | null }) =>
      ipcRenderer.invoke('chromeSync:getStatus', settings),
    syncCookies: (profileDir: string, partition: string) =>
      ipcRenderer.invoke('chromeSync:syncCookies', profileDir, partition),
    getBookmarks: (profileDir: string) =>
      ipcRenderer.invoke('chromeSync:getBookmarks', profileDir),
    searchHistory: (profileDir: string, query: string, limit?: number) =>
      ipcRenderer.invoke('chromeSync:searchHistory', profileDir, query, limit),
  },

  // Local API proxy (Anthropic→OpenAI-compat format transform, routes to Ollama/llama.cpp/LM Studio)
  localProxy: {
    start: () => ipcRenderer.invoke('localProxy:start'),
    stop: () => ipcRenderer.invoke('localProxy:stop'),
    getStatus: () => ipcRenderer.invoke('localProxy:getStatus'),
    probeBackends: () => ipcRenderer.invoke('localProxy:probeBackends'),
  },

  // App settings
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (settings: any) => ipcRenderer.invoke('settings:set', settings),
    getRawJson: () => ipcRenderer.invoke('settings:getRawJson'),
    setRawJson: (json: string) => ipcRenderer.invoke('settings:setRawJson', json),
  },

  permissions: {
    list: () => ipcRenderer.invoke('permissions:list'),
    clear: (id: string) => ipcRenderer.invoke('permissions:clear', id),
    clearAll: () => ipcRenderer.invoke('permissions:clearAll'),
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
    listMessages: (workspacePath: string, tileId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin') => ipcRenderer.invoke('collab:listMessages', workspacePath, tileId, mailbox),
    readMessage: (workspacePath: string, tileId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string) => ipcRenderer.invoke('collab:readMessage', workspacePath, tileId, mailbox, filename),
    sendMessage: (workspacePath: string, fromTileId: string, draft: { toTileId: string; subject: string; body: string; type?: 'request' | 'reply' | 'note' | 'signal' | 'memory'; threadId?: string; replyToId?: string; data?: Record<string, unknown> }) => ipcRenderer.invoke('collab:sendMessage', workspacePath, fromTileId, draft),
    updateMessageStatus: (workspacePath: string, tileId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string, status: 'unread' | 'read' | 'sent' | 'archived') => ipcRenderer.invoke('collab:updateMessageStatus', workspacePath, tileId, mailbox, filename, status),
    moveMessage: (workspacePath: string, tileId: string, fromMailbox: 'inbox' | 'sent' | 'memory' | 'bin', toMailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string) => ipcRenderer.invoke('collab:moveMessage', workspacePath, tileId, fromMailbox, toMailbox, filename),
    watchState: (workspacePath: string, tileId: string) => ipcRenderer.invoke('collab:watchState', workspacePath, tileId),
    unwatchState: (workspacePath: string, tileId: string) => ipcRenderer.invoke('collab:unwatchState', workspacePath, tileId),
    watchMessages: (workspacePath: string, tileId: string) => ipcRenderer.invoke('collab:watchMessages', workspacePath, tileId),
    unwatchMessages: (workspacePath: string, tileId: string) => ipcRenderer.invoke('collab:unwatchMessages', workspacePath, tileId),
    removeTileDir: (workspacePath: string, tileId: string) => ipcRenderer.invoke('collab:removeTileDir', workspacePath, tileId),
    pruneOrphanedTileDirs: (workspacePath: string, tileIds: string[]) => ipcRenderer.invoke('collab:pruneOrphanedTileDirs', workspacePath, tileIds),
    onStateChanged: (callback: (data: { workspacePath: string, tileId: string, state: any }) => void) => {
      const handler = (_: any, data: { workspacePath: string, tileId: string, state: any }) => callback(data)
      ipcRenderer.on('collab:stateChanged', handler)
      return () => { ipcRenderer.removeListener('collab:stateChanged', handler) }
    },
    onMessageChanged: (callback: (data: { workspacePath: string; tileId: string; mailbox: 'inbox' | 'sent' | 'memory' | 'bin'; filename: string; event: 'add' | 'change' | 'unlink'; message?: unknown }) => void) => {
      const handler = (_: any, data: { workspacePath: string; tileId: string; mailbox: 'inbox' | 'sent' | 'memory' | 'bin'; filename: string; event: 'add' | 'change' | 'unlink'; message?: unknown }) => callback(data)
      ipcRenderer.on('collab:messageChanged', handler)
      return () => { ipcRenderer.removeListener('collab:messageChanged', handler) }
    },
  },

  // ContexRelay mailbox IPC — handlers exist only while Relay Suite power extension is active
  relay: {
    init: (workspacePath: string) => ipcRenderer.invoke('relay:init', workspacePath),
    syncWorkspace: (workspaceId: string, workspacePath: string, tiles: any[]) => ipcRenderer.invoke('relay:syncWorkspace', workspaceId, workspacePath, tiles),
    listParticipants: (workspacePath: string) => ipcRenderer.invoke('relay:listParticipants', workspacePath),
    listChannels: (workspacePath: string) => ipcRenderer.invoke('relay:listChannels', workspacePath),
    listCentralFeed: (workspacePath: string, limit?: number) => ipcRenderer.invoke('relay:listCentralFeed', workspacePath, limit),
    listMessages: (workspacePath: string, participantId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', limit?: number) => ipcRenderer.invoke('relay:listMessages', workspacePath, participantId, mailbox, limit),
    readMessage: (workspacePath: string, participantId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string) => ipcRenderer.invoke('relay:readMessage', workspacePath, participantId, mailbox, filename),
    sendDirectMessage: (workspacePath: string, from: string, draft: any) => ipcRenderer.invoke('relay:sendDirectMessage', workspacePath, from, draft),
    sendChannelMessage: (workspacePath: string, from: string, draft: any) => ipcRenderer.invoke('relay:sendChannelMessage', workspacePath, from, draft),
    updateMessageStatus: (workspacePath: string, participantId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string, status: 'unread' | 'read' | 'sent' | 'archived') => ipcRenderer.invoke('relay:updateMessageStatus', workspacePath, participantId, mailbox, filename, status),
    moveMessage: (workspacePath: string, participantId: string, fromMailbox: 'inbox' | 'sent' | 'memory' | 'bin', toMailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string) => ipcRenderer.invoke('relay:moveMessage', workspacePath, participantId, fromMailbox, toMailbox, filename),
    setWorkContext: (workspacePath: string, participantId: string, work: any) => ipcRenderer.invoke('relay:setWorkContext', workspacePath, participantId, work),
    analyzeRelationships: (workspacePath: string) => ipcRenderer.invoke('relay:analyzeRelationships', workspacePath),
    spawnAgent: (workspacePath: string, request: any) => ipcRenderer.invoke('relay:spawnAgent', workspacePath, request),
    stopAgent: (workspacePath: string, participantId: string) => ipcRenderer.invoke('relay:stopAgent', workspacePath, participantId),
    waitForReady: (workspacePath: string, ids: string[], timeoutMs?: number) => ipcRenderer.invoke('relay:waitForReady', workspacePath, ids, timeoutMs),
    waitForAny: (workspacePath: string, ids: string[], timeoutMs?: number) => ipcRenderer.invoke('relay:waitForAny', workspacePath, ids, timeoutMs),
    onEvent: (callback: (data: { workspacePath: string; event: unknown }) => void) => {
      const handler = (_: any, data: { workspacePath: string; event: unknown }) => callback(data)
      ipcRenderer.on('relay:event', handler)
      return () => { ipcRenderer.removeListener('relay:event', handler) }
    },
  },

  // Extensions
  extensions: {
    list: () => ipcRenderer.invoke('ext:list'),
    listSidebar: (workspacePath?: string | null) => ipcRenderer.invoke('ext:list-sidebar', workspacePath),
    listTiles: () => ipcRenderer.invoke('ext:list-tiles'),
    tileEntry: (extId: string, tileType: string, tileId?: string) => ipcRenderer.invoke('ext:tile-entry', extId, tileType, tileId),
    getBridgeScript: (tileId: string, extId: string) => ipcRenderer.invoke('ext:get-bridge-script', tileId, extId),
    enable: (extId: string) => ipcRenderer.invoke('ext:enable', extId),
    disable: (extId: string) => ipcRenderer.invoke('ext:disable', extId),
    refresh: (workspacePath?: string | null) => ipcRenderer.invoke('ext:refresh', workspacePath),
    invoke: (extId: string, method: string, ...args: unknown[]) => ipcRenderer.invoke(`ext:${extId}:${method}`, ...args),
    getSettings: (extId: string) => ipcRenderer.invoke('ext:settings-get', extId),
    setSettings: (extId: string, settings: Record<string, unknown>) => ipcRenderer.invoke('ext:settings-set', extId, settings),
    contextMenuItems: () => ipcRenderer.invoke('ext:context-menu-items'),
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
  },

  // System memory + lifecycle
  system: {
    cleanupTile: (tileId: string) => ipcRenderer.invoke('system:cleanupTile', tileId),
    gc: () => ipcRenderer.invoke('system:gc'),
    memStats: () => ipcRenderer.invoke('system:memStats'),
    daemonStatus: () => ipcRenderer.invoke('system:daemonStatus'),
    daemonSummary: () => ipcRenderer.invoke('system:daemonSummary'),
    restartDaemon: () => ipcRenderer.invoke('system:restartDaemon'),
    onGcRequested: (callback: () => void) => {
      const handler = () => {
        // window.gc exists when renderer is launched with --js-flags=--expose-gc
        const w = window as unknown as { gc?: () => void }
        if (typeof w.gc === 'function') {
          try { w.gc() } catch { /* ignore */ }
        }
        callback()
      }
      ipcRenderer.on('system:gc-requested', handler)
      return () => ipcRenderer.removeListener('system:gc-requested', handler)
    },
  },

  // OS utilities
  homedir: homedir(),
  platform: process.platform,

  // File path extraction for drag/drop — replaces the old File.path field that
  // Electron removed in v32. Must be called in the renderer (which is where the
  // File object lives); preload-side webUtils is the sanctioned path.
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  // UI zoom (webFrame) — reliable alternative to Electron menu role accelerators
  zoom: {
    getLevel: () => webFrame.getZoomLevel(),
    setLevel: (level: number) => webFrame.setZoomLevel(level),
  },
})

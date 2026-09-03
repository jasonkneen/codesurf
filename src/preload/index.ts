import { contextBridge, ipcRenderer, webUtils, webFrame } from 'electron'
import { homedir } from 'os'
import type { AggregatedSessionEntry, SessionEntryHint } from '../shared/session-types'
import type { RecentJobsRequest, RecentJobsResponse } from '../shared/job-types'
import type { ActivityQuery, ActivityUpsertInput } from '../shared/activity-types'
import {
  isTileContextChangeForScope,
  type TileContextChangedPayload,
} from '../shared/tileContextScope'

function channelMatches(pattern: string, channel: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith(':*')) return channel.startsWith(pattern.slice(0, -1))
  return pattern === channel
}

/** Shape of a bus event as it crosses the IPC boundary into the renderer.
 *  Channel is always present; the rest is opaque to the bridge and narrowed
 *  by consumers. */
type RendererBusEvent = { channel: string; type?: string; source?: string; payload?: unknown; [key: string]: unknown }
type BusListener = (event: RendererBusEvent) => void

interface RendererBusSubscription {
  channel: string
  subscriberId: string
  callback: BusListener
}

const rendererBusSubscriptions = new Map<string, RendererBusSubscription>()
const rendererBusGlobalListeners = new Set<BusListener>()
let rendererBusIpcAttached = false

function dispatchRendererBusEvent(evt: RendererBusEvent): void {
  for (const sub of rendererBusSubscriptions.values()) {
    if (evt.channel === sub.channel || channelMatches(sub.channel, evt.channel)) {
      sub.callback(evt)
    }
  }
  for (const listener of rendererBusGlobalListeners) {
    listener(evt)
  }
}

function ensureRendererBusIpcListener(): void {
  if (rendererBusIpcAttached) return
  rendererBusIpcAttached = true
  ipcRenderer.on('bus:event', (_evt, payload) => dispatchRendererBusEvent(payload))
}

function dropRendererBusSubscription(subscriberId: string): void {
  rendererBusSubscriptions.delete(subscriberId)
}

// The full privileged bridge surface. Kept as a plain const so the exposure
// can be gated on the frame this preload runs in (see below).
const electronApi = {
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
    renameProject: (args: { projectId?: string; projectPath?: string; name: string }) => ipcRenderer.invoke('workspace:renameProject', args),
    createProjectWorktree: (args: { projectId?: string; projectPath?: string; name: string; branch?: string }) => ipcRenderer.invoke('workspace:createProjectWorktree', args),
    openFolder: () => ipcRenderer.invoke('workspace:openFolder'),
    delete: (id: string) => ipcRenderer.invoke('workspace:delete', id),
    setActive: (id: string) => ipcRenderer.invoke('workspace:setActive', id),
    getActive: () => ipcRenderer.invoke('workspace:getActive')
  },

  // File system operations
  fs: {
    readDir: (path: string, workspaceId?: string) => ipcRenderer.invoke('fs:readDir', path, workspaceId),
    readFile: (path: string, workspaceId?: string) => ipcRenderer.invoke('fs:readFile', path, workspaceId),
    readFilePrefix: (path: string, maxBytes: number, workspaceId?: string) => ipcRenderer.invoke('fs:readFilePrefix', path, maxBytes, workspaceId),
    writeFile: (path: string, content: string, workspaceId?: string) => ipcRenderer.invoke('fs:writeFile', path, content, workspaceId),
    createFile: (path: string, workspaceId?: string) => ipcRenderer.invoke('fs:createFile', path, workspaceId),
    createDir: (path: string, workspaceId?: string) => ipcRenderer.invoke('fs:createDir', path, workspaceId),
    deleteFile: (path: string, workspaceId?: string) => ipcRenderer.invoke('fs:deleteFile', path, workspaceId),
    renameFile: (oldPath: string, newPath: string, workspaceId?: string) => ipcRenderer.invoke('fs:renameFile', oldPath, newPath, workspaceId),
    watch: (dirPath: string, callback: () => void, workspaceId?: string) => {
      const channel = `fs:watch:${dirPath}`
      const handler = () => callback()
      ipcRenderer.on(channel, handler)
      ipcRenderer.invoke('fs:watchStart', dirPath, workspaceId)
      return () => {
        ipcRenderer.removeListener(channel, handler)
        ipcRenderer.invoke('fs:watchStop', dirPath, workspaceId)
      }
    },
    revealInFinder: (path: string, workspaceId?: string) => ipcRenderer.invoke('fs:revealInFinder', path, workspaceId),
    writeBrief: (cardId: string, content: string) => ipcRenderer.invoke('fs:writeBrief', cardId, content),
    stat: (path: string, workspaceId?: string) => ipcRenderer.invoke('fs:stat', path, workspaceId),
    probeDir: (path: string, workspaceId?: string) => ipcRenderer.invoke('fs:probeDir', path, workspaceId) as Promise<{ ok: true } | { ok: false, code: string }>,
    isProbablyTextFile: (path: string, workspaceId?: string) => ipcRenderer.invoke('fs:isProbablyTextFile', path, workspaceId),
    copyIntoDir: (sourcePath: string, destDir: string, workspaceId?: string) => ipcRenderer.invoke('fs:copyIntoDir', sourcePath, destDir, workspaceId),
    selectDir: () => ipcRenderer.invoke('workspace:openFolder'),
  },

  // .skill bundle install (zip archives containing <name>/SKILL.md + assets).
  // `inspect` peeks at the archive for preview metadata without touching disk.
  // `install` extracts into the Claude skills directory (or a supplied one).
  // `onFileOpened` fires when the user double-clicks a .skill in Finder or
  // passes one on the command line — main forwards the path here so the UI
  // can pop the install-confirmation modal.
  skills: {
    inspect: (zipPath: string) => ipcRenderer.invoke('skills:inspect', zipPath),
    install: (args: { zipPath: string; targetDir?: string; overwrite?: boolean }) =>
      ipcRenderer.invoke('skills:install', args),
    getDefaultTargetDir: () => ipcRenderer.invoke('skills:getDefaultTargetDir') as Promise<string>,
    ready: () => ipcRenderer.invoke('skills:rendererReady'),
    onFileOpened: (callback: (payload: { path: string }) => void) => {
      const handler = (_: unknown, payload: { path: string }) => callback(payload)
      ipcRenderer.on('skill:file-opened', handler)
      return () => { ipcRenderer.removeListener('skill:file-opened', handler) }
    },
  },

  // Tile context (ctx: key-value store)
  tileContext: {
    get: (workspaceId: string, tileId: string, key?: string) => ipcRenderer.invoke('tileContext:get', workspaceId, tileId, key),
    getAll: (workspaceId: string, tileId: string, tagPrefix?: string) => ipcRenderer.invoke('tileContext:getAll', workspaceId, tileId, tagPrefix),
    set: (workspaceId: string, tileId: string, key: string, value: unknown) => ipcRenderer.invoke('tileContext:set', workspaceId, tileId, key, value),
    delete: (workspaceId: string, tileId: string, key: string) => ipcRenderer.invoke('tileContext:delete', workspaceId, tileId, key),
    onChanged: (workspaceId: string, tileId: string, callback: (data: TileContextChangedPayload) => void) => {
      const handler = (_: unknown, data: TileContextChangedPayload) => {
        if (isTileContextChangeForScope(data, workspaceId, tileId)) callback(data)
      }
      ipcRenderer.on('tileContext:changed', handler)
      return () => ipcRenderer.removeListener('tileContext:changed', handler)
    },
  },

  image: {
    edit: (req: { workspaceId: string; tileId: string; prompt: string; provider?: string; model?: string; outputPath?: string }) =>
      ipcRenderer.invoke('image:edit', req),
  },

  // Extension action IPC
  extActions: {
    onAction: (callback: (data: { tileId: string; action: string; params: Record<string, unknown> }) => void) => {
      const handler = (_: unknown, data: { tileId: string; action: string; params: Record<string, unknown> }) => callback(data)
      ipcRenderer.on('ext:action', handler)
      return () => ipcRenderer.removeListener('ext:action', handler)
    },
  },

  // Canvas state persistence
  canvas: {
    load: (workspaceId: string) => ipcRenderer.invoke('canvas:load', workspaceId),
    save: (workspaceId: string, state: unknown) => ipcRenderer.invoke('canvas:save', workspaceId, state),
    loadTileState: (workspaceId: string, tileId: string) => ipcRenderer.invoke('canvas:loadTileState', workspaceId, tileId),
    saveTileState: (workspaceId: string, tileId: string, state: unknown) => ipcRenderer.invoke('canvas:saveTileState', workspaceId, tileId, state),
    clearTileState: (workspaceId: string, tileId: string) => ipcRenderer.invoke('canvas:clearTileState', workspaceId, tileId),
    deleteTileArtifacts: (workspaceId: string, tileId: string) => ipcRenderer.invoke('canvas:deleteTileArtifacts', workspaceId, tileId),
    listSessions: (workspaceId: string, forceRefresh?: boolean) => ipcRenderer.invoke('canvas:listSessions', workspaceId, forceRefresh === true) as Promise<AggregatedSessionEntry[]>,
    onSessionsChanged: (cb: (payload: { workspaceId: string }) => void) => {
      const handler = (_: unknown, payload: { workspaceId: string }) => cb(payload)
      ipcRenderer.on('canvas:sessionsChanged', handler)
      return () => ipcRenderer.removeListener('canvas:sessionsChanged', handler)
    },
    getSessionState: (
      workspaceId: string,
      sessionEntryId: string,
      options?: {
        tailLimit?: number
        entryHint?: SessionEntryHint | null
      },
    ) => ipcRenderer.invoke('canvas:getSessionState', workspaceId, sessionEntryId, options),
    deleteSession: (workspaceId: string, sessionEntryId: string) => ipcRenderer.invoke('canvas:deleteSession', workspaceId, sessionEntryId),
    setSessionArchived: (workspaceId: string, sessionEntryId: string, archived: boolean, identityKey?: string | null) => ipcRenderer.invoke('canvas:setSessionArchived', workspaceId, sessionEntryId, archived, identityKey),
    renameSession: (workspaceId: string, sessionEntryId: string, title: string) => ipcRenderer.invoke('canvas:renameSession', workspaceId, sessionEntryId, title),
    generateSessionTitle: (workspaceId: string, sessionEntryId: string, entryHint?: SessionEntryHint | null) => ipcRenderer.invoke('canvas:generateSessionTitle', workspaceId, sessionEntryId, entryHint),
    listCheckpoints: (workspaceId: string, sessionEntryId: string) => ipcRenderer.invoke('canvas:listCheckpoints', workspaceId, sessionEntryId),
    restoreCheckpoint: (workspaceId: string, checkpointId: string, sessionEntryId?: string) => ipcRenderer.invoke('canvas:restoreCheckpoint', workspaceId, checkpointId, sessionEntryId),
    queuedMessages: {
      append: (event: unknown) => ipcRenderer.invoke('canvas:queuedMessages:append', event),
      listActive: () => ipcRenderer.invoke('canvas:queuedMessages:listActive'),
    },
  },

  // Thread index diagnostics + manual reseed (phase 2 local-SQLite index).
  threads: {
    indexStatus: () => ipcRenderer.invoke('threads:indexStatus'),
    reindex: (workspaceId: string) => ipcRenderer.invoke('threads:reindex', workspaceId),
    onIndexUpdated: (cb: (payload: { workspacePath: string | null; count: number; tombstoned: number; durationMs: number }) => void) => {
      const handler = (_: unknown, payload: { workspacePath: string | null; count: number; tombstoned: number; durationMs: number }) => cb(payload)
      ipcRenderer.on('threads:indexUpdated', handler)
      return () => ipcRenderer.removeListener('threads:indexUpdated', handler)
    },
  },

  // Kanban board state persistence
  kanban: {
    load: (workspaceId: string, tileId: string) => ipcRenderer.invoke('kanban:load', workspaceId, tileId),
    save: (workspaceId: string, tileId: string, state: unknown) => ipcRenderer.invoke('kanban:save', workspaceId, tileId, state)
  },

  // Terminal operations (stub for now)
  terminal: {
    create: (tileId: string, workspaceId: string, workspaceDir: string, launchBin?: string, launchArgs?: string[]) => ipcRenderer.invoke('terminal:create', tileId, workspaceId, workspaceDir, launchBin, launchArgs),
    write: (tileId: string, data: string) => ipcRenderer.invoke('terminal:write', tileId, data),
    cd: (tileId: string, dirPath: string) => ipcRenderer.invoke('terminal:cd', tileId, dirPath),
    resize: (tileId: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', tileId, cols, rows),
    destroy: (tileId: string, workspaceId: string) => ipcRenderer.invoke('terminal:destroy', tileId, workspaceId),
    detach: (tileId: string) => ipcRenderer.invoke('terminal:detach', tileId),
    updatePeers: (tileId: string, workspaceId: string, workspaceDir: string, peers: Array<{ peerId: string; peerType: string; tools: string[] }>) => ipcRenderer.invoke('terminal:update-peers', tileId, workspaceId, workspaceDir, peers),
    onData: (tileId: string, callback: (data: string) => void) => {
      const channel = `terminal:data:${tileId}`
      const handler = (_: unknown, data: string) => callback(data)
      ipcRenderer.on(channel, handler)
      return () => { ipcRenderer.removeListener(channel, handler) }
    },
    onActive: (tileId: string, callback: () => void) => {
      const channel = `terminal:active:${tileId}`
      const handler = () => callback()
      ipcRenderer.on(channel, handler)
      return () => { ipcRenderer.removeListener(channel, handler) }
    },
    onExit: (tileId: string, callback: (exitCode: number) => void) => {
      const channel = `terminal:exit:${tileId}`
      const handler = (_: unknown, exitCode: number) => callback(exitCode)
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
      workspaceId: string
      cardId: string
      provider: string
      model: string
      messages: { role: string; content: string }[]
      runMode?: 'foreground' | 'background'
      mcpEnabled?: boolean
      negotiatedTools?: string[]
      peers?: { peerId: string; peerType: string; tools: string[]; actions?: Array<{ name: string; description: string }>; context?: Record<string, unknown> }[]
      providerTransport?: import('../shared/types').ExtensionChatTransportConfig | null
      recentEditContext?: string
      blockNotesContext?: string
      agentId?: string | null
      agentMode?: import('../shared/types').AgentMode | null
    }) =>
      ipcRenderer.invoke('chat:send', req),
    resumeJob: (req: {
      workspaceId: string
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
    steer: (payload: { workspaceId: string; cardId: string; message: string }) =>
      ipcRenderer.invoke('chat:steer', payload) as Promise<{ ok: boolean; error?: string }>,
    stop: (workspaceId: string, cardId: string) =>
      ipcRenderer.invoke('chat:stop', { workspaceId, cardId }),
    clearSession: (workspaceId: string, cardId: string) =>
      ipcRenderer.invoke('chat:clearSession', { workspaceId, cardId }),
    disposeCard: (workspaceId: string, cardId: string) => ipcRenderer.invoke('chat:disposeCard', { workspaceId, cardId }),
    opencodeModels: () => ipcRenderer.invoke('chat:opencodeModels'),
    gatewayModels: () => ipcRenderer.invoke('chat:gatewayModels'),
    onOpencodeModelsUpdated: (cb: (payload: { models: Array<{ id: string; label: string; description?: string }>; source: string; error?: string }) => void) => {
      const handler = (_: unknown, payload: { models: Array<{ id: string; label: string; description?: string }>; source: string; error?: string }) => cb(payload)
      ipcRenderer.on('chat:opencodeModelsUpdated', handler)
      return () => ipcRenderer.removeListener('chat:opencodeModelsUpdated', handler)
    },
    onGatewayModelsUpdated: (cb: (payload: { models: Array<{ id: string; label: string; description?: string }>; source: string; error?: string }) => void) => {
      const handler = (_: unknown, payload: { models: Array<{ id: string; label: string; description?: string }>; source: string; error?: string }) => cb(payload)
      ipcRenderer.on('chat:gatewayModelsUpdated', handler)
      return () => ipcRenderer.removeListener('chat:gatewayModelsUpdated', handler)
    },
    openclawAgents: () => ipcRenderer.invoke('chat:openclawAgents'),
    csagentModels: () => ipcRenderer.invoke('chat:csagentModels'),
    selectFiles: (workspaceId: string, cardId: string) => ipcRenderer.invoke('chat:selectFiles', workspaceId, cardId) as Promise<Array<{ capability: string; displayName: string }>>,
    authorizeDroppedFiles: (workspaceId: string, cardId: string, files: File[]) => {
      const paths = Array.from(files ?? [])
        .map(file => {
          try { return webUtils.getPathForFile(file) } catch { return '' }
        })
        .filter(Boolean)
      if (paths.length === 0) return Promise.resolve([])
      return ipcRenderer.invoke('chat:authorizeDroppedFiles', workspaceId, cardId, paths) as Promise<Array<{ capability: string; displayName: string }>>
    },
    writeTempAttachment: (payload: { workspaceId: string; cardId: string; data: string; mime?: string; ext?: string; filenameHint?: string }) =>
      ipcRenderer.invoke('chat:writeTempAttachment', payload) as Promise<{ ok: true; attachment: { capability: string; displayName: string } } | { ok: false; error: string }>,
    answerUserQuestion: (payload: {
      workspaceId: string
      cardId: string
      toolId: string | null
      answers: Record<string, string>
      annotations?: Record<string, { notes?: string; preview?: string }>
    }) => ipcRenderer.invoke('chat:answerUserQuestion', payload) as Promise<{ ok: boolean; error?: string }>,
    answerToolPermission: (payload: {
      workspaceId: string
      cardId: string
      toolId: string | null
      // `never` persists a deny-grant so subsequent calls auto-reject.
      decision: 'deny' | 'never' | 'once' | 'session' | 'today' | 'forever'
    }) => ipcRenderer.invoke('chat:answerToolPermission', payload) as Promise<{ ok: boolean; error?: string }>,
    setPermissionMode: (payload: { workspaceId: string; cardId: string; mode: string }) =>
      ipcRenderer.invoke('chat:setPermissionMode', payload) as Promise<{ ok: boolean; error?: string }>,
    loadSessionHistory: (payload: {
      workspaceId?: string
      sessionEntryId?: string
      entryHint?: SessionEntryHint | null
      beforeFingerprint?: string | null
      limit?: number
    }) =>
      ipcRenderer.invoke('chat:loadSessionHistory', payload) as Promise<{
        ok: boolean
        error?: string
        total?: number
        hasMore?: boolean
        provider?: string
        model?: string
        sessionId?: string | null
        messages: Array<import('../shared/chat-types').ChatMessage>
      }>,
  },

  // Agent streaming (SSE/NDJSON parsers for Claude, Codex, Pi)
  stream: {
    start: (req: { cardId: string; agentId: string; url: string; method?: string; headers?: Record<string, string>; body?: string }) =>
      ipcRenderer.invoke('stream:start', req),
    stop: (cardId: string) => ipcRenderer.invoke('stream:stop', cardId),
    onChunk: (cb: (event: { workspaceId: string; cardId: string; type: string; text?: string; toolName?: string; error?: string }) => void) => {
      const handler = (_: unknown, evt: { workspaceId: string; cardId: string; type: string; text?: string; toolName?: string; error?: string }) => cb(evt)
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
    openDevSandbox: () => ipcRenderer.invoke('window:openDevSandbox'),
    newTab: () => ipcRenderer.invoke('window:newTab'),
    newWorkspaceTab: (workspaceId?: string | null) => ipcRenderer.invoke('window:newWorkspaceTab', workspaceId ?? null),
    list: () => ipcRenderer.invoke('window:list'),
    getCurrentId: () => ipcRenderer.invoke('window:getCurrentId'),
    setTitle: (title: string) => ipcRenderer.invoke('window:setTitle', title),
    focusById: (id: number) => ipcRenderer.invoke('window:focusById', id),
    closeById: (id: number) => ipcRenderer.invoke('window:closeById', id),
    openMiniChat: (opts: { workspaceId: string; tileId: string; title?: string }) => ipcRenderer.invoke('window:openMiniChat', opts),
    setSidebarCollapsed: (collapsed: boolean) => ipcRenderer.invoke('window:setSidebarCollapsed', collapsed),
    onPersistenceRequest: (callback: (request: {
      nonce: string
      reason: 'close' | 'quit' | 'reload' | 'force-reload'
      canvasOwner: boolean
    }) => void) => {
      const handler = (_: unknown, request: {
        nonce?: unknown
        reason?: unknown
        canvasOwner?: unknown
      }) => {
        const reason = request?.reason
        const validReason = reason === 'close'
          || reason === 'quit'
          || reason === 'reload'
          || reason === 'force-reload'
        if (
          typeof request?.nonce === 'string'
          && request.nonce.length > 0
          && validReason
          && typeof request.canvasOwner === 'boolean'
        ) {
          callback({
            nonce: request.nonce,
            reason,
            canvasOwner: request.canvasOwner,
          })
        }
      }
      ipcRenderer.on('window:persistence-request', handler)
      return () => ipcRenderer.removeListener('window:persistence-request', handler)
    },
    persistenceReady: (nonce: string) => {
      if (typeof nonce === 'string' && nonce.length > 0) {
        ipcRenderer.send('window:persistence-ready', { nonce })
      }
    },
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

  dreaming: {
    status: (workspaceId: string) => ipcRenderer.invoke('dreaming:status', workspaceId),
    listRuns: (args: { workspaceId: string; limit?: number }) => ipcRenderer.invoke('dreaming:listRuns', args),
    run: (args: { workspaceId: string; provider?: string; model?: string; maxSessions?: number }) => ipcRenderer.invoke('dreaming:run', args),
    cancel: (args: { workspaceId: string; runId?: string | null }) => ipcRenderer.invoke('dreaming:cancel', args),
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
    // Guest <webview> paint throttle: renderer has getWebContentsId only;
    // main resolves WebContents via fromId and calls setFrameRate.
    setFrameRate: (webContentsId: number, fps: number) =>
      ipcRenderer.invoke('webview:setFrameRate', webContentsId, fps) as Promise<{ ok: boolean }>,
    onEvent: (cb: (event: { tileId: string; currentUrl: string; canGoBack: boolean; canGoForward: boolean; isLoading: boolean; mode: 'desktop' | 'mobile' }) => void) => {
      const handler = (_: unknown, evt: { tileId: string; currentUrl: string; canGoBack: boolean; canGoForward: boolean; isLoading: boolean; mode: 'desktop' | 'mobile' }) => cb(evt)
      ipcRenderer.on('browserTile:event', handler)
      return () => { ipcRenderer.removeListener('browserTile:event', handler) }
    },
    // Forwarded from the main process — fires when a guest webview calls window.open
    // or follows a target=_blank link. The `new-window` DOM event was removed in
    // Electron 22; this IPC path replaces it.
    onNewWindow: (cb: (event: { url: string }) => void) => {
      const handler = (_: unknown, evt: { url: string }) => cb(evt)
      ipcRenderer.on('webview:new-window', handler)
      return () => { ipcRenderer.removeListener('webview:new-window', handler) }
    },
  },

  owl: {
    health: () => ipcRenderer.invoke('owl:health'),
    createSession: (options?: { appName?: string; buildFlavor?: string }) =>
      ipcRenderer.invoke('owl:session:create', options ?? {}),
    createProfile: (options: { sessionId: string; name?: string; persistent?: boolean; storageKey?: string; isolateForAgent?: boolean }) =>
      ipcRenderer.invoke('owl:profile:create', options),
    createWebView: (options: { profileId: string; initialUrl?: string; width?: number; height?: number; deviceScaleFactor?: number; visible?: boolean }) =>
      ipcRenderer.invoke('owl:webview:create', options),
    navigate: (options: { webViewId: string; url: string }) =>
      ipcRenderer.invoke('owl:webview:navigate', options),
    setGeometry: (options: { webViewId: string; width: number; height: number; deviceScaleFactor?: number }) =>
      ipcRenderer.invoke('owl:webview:setGeometry', options),
    dispatchInput: (options: { webViewId: string; route?: 'content' | 'browser'; event: Record<string, unknown> }) =>
      ipcRenderer.invoke('owl:webview:dispatchInput', options),
    capture: (options: { webViewId: string; includePopups?: boolean }) =>
      ipcRenderer.invoke('owl:webview:capture', options),
    destroy: (webViewId: string) => ipcRenderer.invoke('owl:webview:destroy', webViewId),
    stop: () => ipcRenderer.invoke('owl:stop'),
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
    set: (settings: unknown) => ipcRenderer.invoke('settings:set', settings),
    getRawJson: () => ipcRenderer.invoke('settings:getRawJson'),
    setRawJson: (json: string) => ipcRenderer.invoke('settings:setRawJson', json),
    validateGenerationProvider: (providerId: string, providerPatch?: Record<string, unknown>) =>
      ipcRenderer.invoke('settings:validateGenerationProvider', providerId, providerPatch),
  },

  permissions: {
    list: () => ipcRenderer.invoke('permissions:list'),
    clear: (id: string) => ipcRenderer.invoke('permissions:clear', id),
    clearAll: () => ipcRenderer.invoke('permissions:clearAll'),
  },

  jobs: {
    recent: (req?: RecentJobsRequest): Promise<RecentJobsResponse> =>
      ipcRenderer.invoke('jobs:recent', req ?? {}),
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
    getToken: () => ipcRenderer.invoke('mcp:getToken') as Promise<string>,
    getConfig: () => ipcRenderer.invoke('mcp:getConfig'),
    saveServers: (servers: Record<string, unknown>) => ipcRenderer.invoke('mcp:saveServers', servers),
    getWorkspaceServers: (workspaceId: string) => ipcRenderer.invoke('mcp:getWorkspaceServers', workspaceId),
    saveWorkspaceServers: (workspaceId: string, servers: Record<string, unknown>) => ipcRenderer.invoke('mcp:saveWorkspaceServers', workspaceId, servers),
    getMergedConfig: (workspaceId: string) => ipcRenderer.invoke('mcp:getMergedConfig', workspaceId),
    onKanban: (cb: (event: string, data: unknown) => void) => {
      const handler = (_: unknown, payload: { event: string; data: unknown }) => cb(payload.event, payload.data)
      ipcRenderer.on('mcp:kanban', handler)
      return () => { ipcRenderer.removeListener('mcp:kanban', handler) }
    },
    onInject: (cb: (workspaceId: string, cardId: string, message: string, appendNewline: boolean) => void) => {
      const handler = (_: unknown, payload: { workspaceId: string; cardId: string; message: string; appendNewline: boolean }) => cb(payload.workspaceId, payload.cardId, payload.message, payload.appendNewline)
      ipcRenderer.on('mcp:inject', handler)
      return () => { ipcRenderer.removeListener('mcp:inject', handler) }
    },
    inject: (cardId: string, message: string) =>
      ipcRenderer.invoke('terminal:write', cardId, message + '\r')
  },

  // Activity store (persisted per-workspace)
  activity: {
    upsert: (workspaceId: string, data: ActivityUpsertInput) => ipcRenderer.invoke('activity:upsert', workspaceId, data),
    query: (query: ActivityQuery) => ipcRenderer.invoke('activity:query', query),
    byTile: (workspaceId: string, tileId: string) => ipcRenderer.invoke('activity:byTile', workspaceId, tileId),
    delete: (workspaceId: string, tileId: string, id: string) => ipcRenderer.invoke('activity:delete', workspaceId, tileId, id),
    clearTile: (workspaceId: string, tileId: string) => ipcRenderer.invoke('activity:clearTile', workspaceId, tileId),
    byAgent: (workspaceId: string) => ipcRenderer.invoke('activity:byAgent', workspaceId),
    health: (workspaceId: string) => ipcRenderer.invoke('activity:health', workspaceId),
  },

  // CodeSurf protocol (.codesurf folder)
  collab: {
    ensureDir: (workspacePath: string, tileId: string) => ipcRenderer.invoke('collab:ensureDir', workspacePath, tileId),
    writeObjective: (workspacePath: string, tileId: string, md: string) => ipcRenderer.invoke('collab:writeObjective', workspacePath, tileId, md),
    readObjective: (workspacePath: string, tileId: string) => ipcRenderer.invoke('collab:readObjective', workspacePath, tileId),
    writeSkills: (workspacePath: string, tileId: string, skills: { enabled: string[], disabled: string[] }) => ipcRenderer.invoke('collab:writeSkills', workspacePath, tileId, skills),
    readSkills: (workspacePath: string, tileId: string) => ipcRenderer.invoke('collab:readSkills', workspacePath, tileId),
    writeState: (workspacePath: string, tileId: string, state: unknown) => ipcRenderer.invoke('collab:writeState', workspacePath, tileId, state),
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
    onStateChanged: (callback: (data: { workspacePath: string, tileId: string, state: unknown }) => void) => {
      const handler = (_: unknown, data: { workspacePath: string, tileId: string, state: unknown }) => callback(data)
      ipcRenderer.on('collab:stateChanged', handler)
      return () => { ipcRenderer.removeListener('collab:stateChanged', handler) }
    },
    onMessageChanged: (callback: (data: { workspacePath: string; tileId: string; mailbox: 'inbox' | 'sent' | 'memory' | 'bin'; filename: string; event: 'add' | 'change' | 'unlink'; message?: unknown }) => void) => {
      const handler = (_: unknown, data: { workspacePath: string; tileId: string; mailbox: 'inbox' | 'sent' | 'memory' | 'bin'; filename: string; event: 'add' | 'change' | 'unlink'; message?: unknown }) => callback(data)
      ipcRenderer.on('collab:messageChanged', handler)
      return () => { ipcRenderer.removeListener('collab:messageChanged', handler) }
    },
  },

  // CodesurfRelay mailbox IPC — handlers exist only while Relay Suite power extension is active
  relay: {
    init: (workspacePath: string) => ipcRenderer.invoke('relay:init', workspacePath),
    syncWorkspace: (workspaceId: string, workspacePath: string, tiles: unknown[]) => ipcRenderer.invoke('relay:syncWorkspace', workspaceId, workspacePath, tiles),
    listParticipants: (workspacePath: string) => ipcRenderer.invoke('relay:listParticipants', workspacePath),
    listChannels: (workspacePath: string) => ipcRenderer.invoke('relay:listChannels', workspacePath),
    listCentralFeed: (workspacePath: string, limit?: number) => ipcRenderer.invoke('relay:listCentralFeed', workspacePath, limit),
    listMessages: (workspacePath: string, participantId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', limit?: number) => ipcRenderer.invoke('relay:listMessages', workspacePath, participantId, mailbox, limit),
    readMessage: (workspacePath: string, participantId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string) => ipcRenderer.invoke('relay:readMessage', workspacePath, participantId, mailbox, filename),
    sendDirectMessage: (workspacePath: string, from: string, draft: unknown) => ipcRenderer.invoke('relay:sendDirectMessage', workspacePath, from, draft),
    sendChannelMessage: (workspacePath: string, from: string, draft: unknown) => ipcRenderer.invoke('relay:sendChannelMessage', workspacePath, from, draft),
    updateMessageStatus: (workspacePath: string, participantId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string, status: 'unread' | 'read' | 'sent' | 'archived') => ipcRenderer.invoke('relay:updateMessageStatus', workspacePath, participantId, mailbox, filename, status),
    moveMessage: (workspacePath: string, participantId: string, fromMailbox: 'inbox' | 'sent' | 'memory' | 'bin', toMailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string) => ipcRenderer.invoke('relay:moveMessage', workspacePath, participantId, fromMailbox, toMailbox, filename),
    setWorkContext: (workspacePath: string, participantId: string, work: unknown) => ipcRenderer.invoke('relay:setWorkContext', workspacePath, participantId, work),
    analyzeRelationships: (workspacePath: string) => ipcRenderer.invoke('relay:analyzeRelationships', workspacePath),
    spawnAgent: (workspacePath: string, request: unknown) => ipcRenderer.invoke('relay:spawnAgent', workspacePath, request),
    stopAgent: (workspacePath: string, participantId: string) => ipcRenderer.invoke('relay:stopAgent', workspacePath, participantId),
    waitForReady: (workspacePath: string, ids: string[], timeoutMs?: number) => ipcRenderer.invoke('relay:waitForReady', workspacePath, ids, timeoutMs),
    waitForAny: (workspacePath: string, ids: string[], timeoutMs?: number) => ipcRenderer.invoke('relay:waitForAny', workspacePath, ids, timeoutMs),
    onEvent: (callback: (data: { workspacePath: string; event: unknown }) => void) => {
      const handler = (_: unknown, data: { workspacePath: string; event: unknown }) => callback(data)
      ipcRenderer.on('relay:event', handler)
      return () => { ipcRenderer.removeListener('relay:event', handler) }
    },
  },

  // Extensions
  extensions: {
    list: () => ipcRenderer.invoke('ext:list'),
    listSidebar: (workspacePath?: string | null) => ipcRenderer.invoke('ext:list-sidebar', workspacePath),
    listTiles: () => ipcRenderer.invoke('ext:list-tiles'),
    listChatSurfaces: () => ipcRenderer.invoke('ext:list-chat-surfaces'),
    tileEntry: (extId: string, tileType: string, tileId?: string) => ipcRenderer.invoke('ext:tile-entry', extId, tileType, tileId),
    chatSurfaceEntry: (extId: string, surfaceId: string, instanceId?: string) => ipcRenderer.invoke('ext:chat-surface-entry', extId, surfaceId, instanceId),
    getBridgeScript: (tileId: string, extId: string) => ipcRenderer.invoke('ext:get-bridge-script', tileId, extId),
    capabilityGate: (extId: string) => ipcRenderer.invoke('ext:capability-gate', extId),
    enable: (extId: string) => ipcRenderer.invoke('ext:enable', extId),
    disable: (extId: string) => ipcRenderer.invoke('ext:disable', extId),
    installFromFile: () => ipcRenderer.invoke('ext:install-from-file'),
    refresh: (workspacePath?: string | null) => ipcRenderer.invoke('ext:refresh', workspacePath),
    invoke: (extId: string, method: string, ...args: unknown[]) => ipcRenderer.invoke(`ext:${extId}:${method}`, ...args),
    getSettings: (extId: string) => ipcRenderer.invoke('ext:settings-get', extId),
    setSettings: (extId: string, settings: Record<string, unknown>) => ipcRenderer.invoke('ext:settings-set', extId, settings),
    contextMenuItems: () => ipcRenderer.invoke('ext:context-menu-items'),
    // v2: aggregated contributions (omit kind for all groups, or pass one kind)
    contributions: (kind?: string) => ipcRenderer.invoke('ext:contributions', kind),
    // v2: resolve a contribution entry to HTML (render:'mcp-ui' / 'iframe' feed)
    surfaceHtml: (extId: string, kind: string, surfaceId: string) => ipcRenderer.invoke('ext:surface-html', extId, kind, surfaceId),
    // v2: durable reactive per-plugin store
    storeGet: (extId: string) => ipcRenderer.invoke('ext:store-get', extId),
    storeSet: (extId: string, patch: Record<string, unknown>) => ipcRenderer.invoke('ext:store-set', extId, patch),
    storeReplace: (extId: string, value: Record<string, unknown>) => ipcRenderer.invoke('ext:store-replace', extId, value),
  },

  // Event bus
  bus: {
    publish: (channel: string, type: string, source: string, payload: Record<string, unknown>) =>
      ipcRenderer.invoke('bus:publish', channel, type, source, payload),
    subscribe: (channel: string, subscriberId: string, callback: (event: RendererBusEvent) => void) => {
      ensureRendererBusIpcListener()
      rendererBusSubscriptions.set(subscriberId, { channel, subscriberId, callback })
      void ipcRenderer.invoke('bus:subscribe', channel, subscriberId)
      return () => {
        dropRendererBusSubscription(subscriberId)
        void ipcRenderer.invoke('bus:unsubscribeAll', subscriberId)
      }
    },
    unsubscribeAll: (subscriberId: string) => {
      dropRendererBusSubscription(subscriberId)
      return ipcRenderer.invoke('bus:unsubscribeAll', subscriberId)
    },
    history: (channel: string, limit?: number) => ipcRenderer.invoke('bus:history', channel, limit),
    channelInfo: (channel: string) => ipcRenderer.invoke('bus:channelInfo', channel),
    unreadCount: (channel: string, subscriberId: string) => ipcRenderer.invoke('bus:unreadCount', channel, subscriberId),
    markRead: (channel: string, subscriberId: string) => ipcRenderer.invoke('bus:markRead', channel, subscriberId),
    onEvent: (callback: (event: RendererBusEvent) => void) => {
      ensureRendererBusIpcListener()
      rendererBusGlobalListeners.add(callback)
      return () => { rendererBusGlobalListeners.delete(callback) }
    }
  },

  // Local SQLite diagnostics (phase 0 harness; no feature code reads/writes it yet).
  db: {
    status: () => ipcRenderer.invoke('db:status'),
    reset: () => ipcRenderer.invoke('db:reset'),
  },

  // System memory + lifecycle
  system: {
    cleanupTile: (workspaceId: string, tileId: string) => ipcRenderer.invoke('system:cleanupTile', workspaceId, tileId),
    gc: () => ipcRenderer.invoke('system:gc'),
    memStats: () => ipcRenderer.invoke('system:memStats'),
    daemonStatus: () => ipcRenderer.invoke('system:daemonStatus'),
    daemonSummary: () => ipcRenderer.invoke('system:daemonSummary'),
    restartDaemon: () => ipcRenderer.invoke('system:restartDaemon'),
    requestMediaAccess: (args?: { kind?: 'microphone' | 'camera' }) =>
      ipcRenderer.invoke('system:requestMediaAccess', args) as Promise<{
        granted: boolean
        status: string
        openedSettings?: boolean
      }>,
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

  // UI zoom — routed through main so the chosen level persists to
  // ~/.codesurf/ui-state.json and is restored on the next app launch.
  // getLevel reads what main currently has applied (via webFrame, so it
  // reflects the live zoom state immediately after setLevel resolves).
  zoom: {
    getLevel: () => webFrame.getZoomLevel(),
    setLevel: async (level: number) => {
      await ipcRenderer.invoke('ui:setZoomLevel', level)
    },
  },

  // ─── Canvas perf feature flags (CODESURF_PERF_*) — read once at startup ─
  perf: {
    getEnv: (): Record<string, string> => {
      const out: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('CODESURF_PERF_') && typeof value === 'string') out[key] = value
      }
      return out
    },
  },

  // ─── Voice: STT, TTS, spokify, secrets ────────────────────────────────
  // STT: capture audio in renderer (MediaRecorder), send bytes to main,
  // main routes to provider (OpenAI Whisper / Deepgram / AssemblyAI / local).
  transcribe: {
    run: (args: {
      audio: ArrayBuffer
      mimeType: string
      provider?: 'openai' | 'deepgram' | 'assemblyai' | 'local'
      lang?: string
      localBaseUrl?: string
      openaiModel?: string
      deepgramModel?: string
    }): Promise<{ ok: boolean; text?: string; error?: string }> =>
      ipcRenderer.invoke('transcribe:run', args),
  },

  // TTS: synthesize spoken audio for a given text. Provider router on main side.
  // Returns audio bytes + mime type. Renderer wraps in Blob and plays.
  tts: {
    synthesize: (args: {
      text: string
      provider?: 'cartesia' | 'deepgram' | 'elevenlabs' | 'voicelab' | 'say'
      voice?: string
      model?: string
      voiceLabBaseUrl?: string
      elevenModel?: string
      deepgramModel?: string
    }): Promise<{ ok: boolean; audio?: Uint8Array; mimeType?: string; error?: string }> =>
      ipcRenderer.invoke('tts:synthesize', args),
  },

  // Spokify: rewrite assistant message into natural spoken narration.
  // Strips code blocks, drops markdown, smooths punctuation. LLM-backed.
  spokify: {
    run: (args: { text: string; model?: string }): Promise<{ ok: boolean; text?: string; error?: string }> =>
      ipcRenderer.invoke('spokify:run', args),
  },

  // Secrets: encrypted API key storage. Renderer can set/clear/check
  // existence but cannot read keys back (they live in main only).
  secrets: {
    set: (name: string, value: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('secrets:set', { name, value }),
    delete: (name: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('secrets:delete', name),
    list: (): Promise<{ ok: boolean; names: string[] }> =>
      ipcRenderer.invoke('secrets:list'),
    has: (name: string): Promise<{ ok: boolean; has: boolean }> =>
      ipcRenderer.invoke('secrets:has', name),
  },

  // Pets: discover, install, select, and remove animated mascot bundles.
  // Shares the codex-rs / grok-cli / hermes pet format (pet.json + spritesheet.webp).
  pets: {
    list: () => ipcRenderer.invoke('pets:list') as Promise<
      import('../shared/pet-types').PetListResponse
    >,
    gallery: () => ipcRenderer.invoke('pets:gallery') as Promise<
      import('../shared/pet-types').PetGalleryResponse
    >,
    galleryLocal: () => ipcRenderer.invoke('pets:gallery-local') as Promise<
      import('../shared/pet-types').PetGalleryResponse
    >,
    install: (slug: string) => ipcRenderer.invoke('pets:install', slug) as Promise<
      import('../shared/pet-types').PetInstallResponse
    >,
    remove: (slug: string) => ipcRenderer.invoke('pets:remove', slug) as Promise<
      import('../shared/pet-types').PetRemoveResponse
    >,
    thumbnail: (slug: string) => ipcRenderer.invoke('pets:thumbnail', slug) as Promise<string | null>,
    thumbnailData: (slug: string) => ipcRenderer.invoke('pets:thumbnailData', slug) as Promise<string | null>,
    spritesheetData: (slug: string) => ipcRenderer.invoke('pets:spritesheetData', slug) as Promise<string | null>,
    getManifest: (slug: string) => ipcRenderer.invoke('pets:getManifest', slug) as Promise<
      import('../shared/pet-types').PetManifest | null
    >,
    onGalleryChanged: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('pets:gallery-changed', handler)
      return () => { ipcRenderer.removeListener('pets:gallery-changed', handler) }
    },
  },
}

// Expose IPC bridges to the renderer — main frame only. This preload runs in
// EVERY iframe of the window, and the app deliberately frames untrusted
// content (extension tiles, MCP-UI guest HTML, arbitrary-URL previews). Those
// frames must not inherit fs/terminal/secrets access. First-party iframes
// reach the host through their own postMessage RPC bridges instead.
if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('electron', electronApi)
}

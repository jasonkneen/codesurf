import type { TileContextEntry } from '../../shared/types.ts'
import {
  isTileContextChangeForScope,
  type TileContextChangedPayload,
} from '../../shared/tileContextScope.ts'

export type ElectrobunInvokeArgs = unknown[]

export interface ElectrobunInvokeCall {
  channel: string
  args: ElectrobunInvokeArgs
}

export type ElectrobunInvoke = (channel: string, args: ElectrobunInvokeArgs) => Promise<unknown>
export type ElectrobunEventHandler = (payload: unknown) => void
export type ElectrobunUnsubscribe = () => void

export interface ElectrobunEventHub {
  on(channel: string, handler: ElectrobunEventHandler): ElectrobunUnsubscribe
  emit(channel: string, payload: unknown): void
}

type EventWithChannel = {
  channel?: string
  payload?: unknown
}

type FacadeOptions = {
  invoke: ElectrobunInvoke
  platform: string
  homedir: string
  eventHub?: ElectrobunEventHub
}

type HostBackedFacadeOptions = Omit<FacadeOptions, 'homedir'> & {
  hostHomedir: unknown
}

export function createElectrobunEventHub(): ElectrobunEventHub {
  const handlers = new Map<string, Set<ElectrobunEventHandler>>()

  return {
    on(channel, handler) {
      const set = handlers.get(channel) ?? new Set<ElectrobunEventHandler>()
      set.add(handler)
      handlers.set(channel, set)
      return () => {
        set.delete(handler)
        if (set.size === 0) handlers.delete(channel)
      }
    },
    emit(channel, payload) {
      handlers.get(channel)?.forEach(handler => handler(payload))
      if (channel !== '*') handlers.get('*')?.forEach(handler => handler(payload))
    },
  }
}

export function withElectrobunHostBootstrap(
  preloadSource: string,
  hostHomedir: string,
  selfCheck = false,
): string {
  if (!hostHomedir.trim()) throw new Error('Electrobun host home directory is empty')
  if (!preloadSource.trim()) throw new Error('Electrobun bridge preload source is empty')
  const bootstrap = JSON.stringify({ homedir: hostHomedir, selfCheck: selfCheck === true })
  return `Object.defineProperty(globalThis, '__codesurfElectrobunHostBootstrap', { value: Object.freeze(${bootstrap}), configurable: false, enumerable: false, writable: false });\n${preloadSource}`
}

export function createHostBackedElectrobunElectronFacade(
  options: HostBackedFacadeOptions,
): any {
  const { hostHomedir: rawHostHomedir, ...facadeOptions } = options
  const hostHomedir = typeof rawHostHomedir === 'string' ? rawHostHomedir.trim() : ''
  if (!hostHomedir) {
    throw new Error('Electrobun host did not provide a valid home directory')
  }
  return createElectrobunElectronFacade({ ...facadeOptions, homedir: hostHomedir })
}

export function getDefaultElectrobunInvokeResponse(channel: string): unknown {
  if (channel === 'activity:health') return { available: false, status: 'unavailable' }
  if (channel.startsWith('activity:')) {
    throw new Error('Activity persistence is unavailable in the Electrobun host')
  }
  if (channel === 'settings:validateGenerationProvider') {
    return { ok: false, message: 'Electrobun runtime did not respond to provider validation.', models: [], imageModels: [], videoModels: [] }
  }

  if (channel === 'ext:list-sidebar') return { entries: [], tiles: [] }

  if (
    channel === 'chat:opencodeModels'
    || channel === 'chat:gatewayModels'
    || channel === 'chat:openclawAgents'
    || channel === 'execution:listHosts'
    || channel === 'dreaming:listRuns'
    || channel === 'extensions:list'
    || channel === 'ext:list'
    || channel === 'ext:list-tiles'
    || channel === 'ext:list-chat-surfaces'
    || channel === 'ext:context-menu-items'
    || channel === 'permissions:list'
  ) return []

  if (
    channel === 'extensions:tileEntry'
    || channel === 'extensions:chatSurfaceEntry'
    || channel === 'ext:tile-entry'
    || channel === 'ext:chat-surface-entry'
  ) return null

  if (channel === 'appearance:shouldUseDark') return true
  if (channel === 'window:isFresh') return false
  if (channel === 'window:list') return []
  if (channel === 'window:getCurrentId') return 1
  if (channel === 'zoom:getLevel') return 0
  if (channel === 'mcp:getPort') return null
  if (channel === 'mcp:getToken') return ''
  if (channel === 'mcp:getWorkspaceServers') return {}
  if (channel === 'system:memStats') return { heapUsed: 0, heapTotal: 0, rss: 0 }
  if (channel === 'system:daemonStatus') return null
  if (channel === 'system:daemonSummary') return null
  if (channel === 'system:requestMediaAccess') return { granted: true, status: 'granted' }
  if (channel === 'db:status') return { ok: false, runtime: 'electrobun-fallback', message: 'Electrobun runtime DB handler was unavailable.' }
  if (channel === 'jobs:recent') return { jobs: [], total: 0, limit: 50, offset: 0 }
  if (channel === 'updater:check') return { ok: true, status: 'disabled-electrobun-runtime', updateAvailable: false }
  if (channel === 'chat:writeTempAttachment') return { ok: false, error: 'Electrobun runtime attachment handler was unavailable.' }
  if (channel === 'chat:csagentModels') return { models: [] }
  if (channel === 'transcribe:run') return { ok: false, error: 'Electrobun runtime transcribe handler was unavailable.' }
  if (channel === 'tts:synthesize') return { ok: false, error: 'Electrobun runtime TTS handler was unavailable.' }
  if (channel === 'spokify:run') return { ok: false, error: 'Electrobun runtime spokify handler was unavailable.' }
  if (channel === 'secrets:set' || channel === 'secrets:delete') {
    return { ok: false, error: 'Electrobun secure secret storage is unavailable.' }
  }
  if (channel === 'secrets:list') return { ok: false, names: [], error: 'Electrobun secure secret storage is unavailable.' }
  if (channel === 'secrets:has') return { ok: false, has: false, error: 'Electrobun secure secret storage is unavailable.' }
  if (channel === 'ext:capability-gate') return { ok: false, reason: 'Electrobun runtime extension gate unavailable.' }
  if (channel === 'ext:install-from-file') return null
  if (channel === 'ext:contributions') return []
  if (channel === 'ext:surface-html') return ''
  if (channel === 'ext:store-get') return {}
  if (channel === 'ext:store-replace' || channel === 'ext:store-set') {
    return { ok: false, error: 'Electrobun extension state persistence is unavailable.' }
  }
  if (channel === 'localProxy:getStatus') return { running: false }
  if (channel === 'localProxy:probeBackends') return []
  if (channel === 'dreaming:status') return { running: false, auto: null, lastRun: null }
  if (channel === 'fs:probeDir') return { ok: false, code: 'ENOENT' }
  if (channel === 'fs:isProbablyTextFile') return false
  if (channel === 'git:status') return { isRepo: false, root: '', files: [] }
  if (channel === 'git:branches') return { current: null, branches: [] }
  if (channel === 'agents:detect') return []
  if (channel === 'agentPaths:get') return {}
  if (channel === 'agentPaths:detect') return {}
  if (channel === 'agentPaths:needsSetup') return false
  if (channel === 'skills:getDefaultTargetDir') return ''
  if (channel === 'skills:inspect') return { ok: false, error: 'Electrobun runtime skill inspection handler was unavailable.' }
  if (channel === 'pets:list' || channel === 'pets:gallery' || channel === 'pets:gallery-local') return []
  if (channel === 'pets:install' || channel === 'pets:remove') return { ok: false, error: 'Electrobun pets handler unavailable.' }
  if (channel === 'pets:thumbnail' || channel === 'pets:thumbnailData' || channel === 'pets:spritesheetData' || channel === 'pets:getManifest') return null
  if (channel === 'webview:setFrameRate') {
    return { ok: false, runtime: 'electrobun-fallback', error: 'Electrobun frame-rate control is unavailable.' }
  }

  throw new Error(`Electrobun host did not provide a safe fallback for ${channel}`)
}

export async function invokeElectrobunWithFallback(
  channel: string,
  request: () => Promise<unknown>,
): Promise<unknown> {
  const result = await request()
  return result === undefined ? getDefaultElectrobunInvokeResponse(channel) : result
}

function channelMatches(pattern: string, channel: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith(':*')) return channel.startsWith(pattern.slice(0, -1))
  return pattern === channel
}

function makeInvoker(invoke: ElectrobunInvoke, channel: string) {
  return (...args: ElectrobunInvokeArgs) => invoke(channel, args)
}

function makeEventListener(eventHub: ElectrobunEventHub, channel: string) {
  return (callback: (payload: any) => void) => eventHub.on(channel, payload => callback(payload))
}

function makeFilteredBusListener(eventHub: ElectrobunEventHub, pattern: string, callback: (payload: any) => void) {
  return eventHub.on('bus:event', payload => {
    const event = payload as EventWithChannel
    if (event?.channel && channelMatches(pattern, event.channel)) callback(event)
  })
}

export function createElectrobunElectronFacade(options: FacadeOptions): any {
  const eventHub = options.eventHub ?? createElectrobunEventHub()
  const invoke = options.invoke
  let zoomLevel = 0
  const resolveWorkspaceScope = async (workspaceId?: string): Promise<string> => {
    const explicit = typeof workspaceId === 'string' ? workspaceId.trim() : ''
    if (explicit) return explicit
    const active = await invoke('workspace:getActive', []) as { id?: unknown } | null
    const activeId = typeof active?.id === 'string' ? active.id.trim() : ''
    if (!activeId) throw new Error('No active workspace is available for the filesystem request')
    return activeId
  }
  const invokeFs = async (
    channel: string,
    args: ElectrobunInvokeArgs,
    workspaceId?: string,
  ): Promise<unknown> => invoke(channel, [...args, await resolveWorkspaceScope(workspaceId)])

  return {
    __codesurfHostKind: 'electrobun',
    appearance: {
      shouldUseDark: makeInvoker(invoke, 'appearance:shouldUseDark'),
      setThemeSource: makeInvoker(invoke, 'appearance:setThemeSource'),
      onUpdated: makeEventListener(eventHub, 'appearance:updated'),
    },
    workspace: {
      list: makeInvoker(invoke, 'workspace:list'),
      listProjects: makeInvoker(invoke, 'workspace:listProjects'),
      create: makeInvoker(invoke, 'workspace:create'),
      createWithPath: makeInvoker(invoke, 'workspace:createWithPath'),
      createFromFolder: makeInvoker(invoke, 'workspace:createFromFolder'),
      addProjectFolder: makeInvoker(invoke, 'workspace:addProjectFolder'),
      removeProjectFolder: makeInvoker(invoke, 'workspace:removeProjectFolder'),
      renameProject: makeInvoker(invoke, 'workspace:renameProject'),
      createProjectWorktree: makeInvoker(invoke, 'workspace:createProjectWorktree'),
      openFolder: makeInvoker(invoke, 'workspace:openFolder'),
      delete: makeInvoker(invoke, 'workspace:delete'),
      setActive: makeInvoker(invoke, 'workspace:setActive'),
      getActive: makeInvoker(invoke, 'workspace:getActive'),
    },
    fs: {
      readDir: (path: string, workspaceId?: string) => invokeFs('fs:readDir', [path], workspaceId),
      readFile: (path: string, workspaceId?: string) => invokeFs('fs:readFile', [path], workspaceId),
      readFilePrefix: (path: string, maxBytes: number, workspaceId?: string) => invokeFs('fs:readFilePrefix', [path, maxBytes], workspaceId),
      writeFile: (path: string, content: string, workspaceId?: string) => invokeFs('fs:writeFile', [path, content], workspaceId),
      createFile: (path: string, workspaceId?: string) => invokeFs('fs:createFile', [path], workspaceId),
      createDir: (path: string, workspaceId?: string) => invokeFs('fs:createDir', [path], workspaceId),
      deleteFile: (path: string, workspaceId?: string) => invokeFs('fs:deleteFile', [path], workspaceId),
      renameFile: (oldPath: string, newPath: string, workspaceId?: string) => invokeFs('fs:renameFile', [oldPath, newPath], workspaceId),
      watch: (dirPath: string, callback: () => void, workspaceId?: string) => {
        const start = resolveWorkspaceScope(workspaceId).then(async resolvedWorkspaceId => {
          await invoke('fs:watchStart', [dirPath, resolvedWorkspaceId])
          return resolvedWorkspaceId
        })
        const off = eventHub.on(`fs:watch:${dirPath}`, () => callback())
        return () => {
          off()
          void start.then(resolvedWorkspaceId => invoke('fs:watchStop', [dirPath, resolvedWorkspaceId]))
        }
      },
      revealInFinder: (path: string, workspaceId?: string) => invokeFs('fs:revealInFinder', [path], workspaceId),
      writeBrief: makeInvoker(invoke, 'fs:writeBrief'),
      stat: (path: string, workspaceId?: string) => invokeFs('fs:stat', [path], workspaceId),
      probeDir: (path: string, workspaceId?: string) => invokeFs('fs:probeDir', [path], workspaceId),
      isProbablyTextFile: (path: string, workspaceId?: string) => invokeFs('fs:isProbablyTextFile', [path], workspaceId),
      copyIntoDir: (sourcePath: string, destDir: string, workspaceId?: string) => invokeFs('fs:copyIntoDir', [sourcePath, destDir], workspaceId),
      selectDir: makeInvoker(invoke, 'workspace:openFolder'),
    },
    skills: {
      inspect: makeInvoker(invoke, 'skills:inspect'),
      install: makeInvoker(invoke, 'skills:install'),
      getDefaultTargetDir: makeInvoker(invoke, 'skills:getDefaultTargetDir'),
      ready: makeInvoker(invoke, 'skills:rendererReady'),
      onFileOpened: makeEventListener(eventHub, 'skill:file-opened'),
    },
    tileContext: {
      get: (workspaceId: string, tileId: string, key?: string) => (
        invoke('tileContext:get', [workspaceId, tileId, key]) as Promise<TileContextEntry | Record<string, TileContextEntry> | null>
      ),
      getAll: (workspaceId: string, tileId: string, tagPrefix?: string) => (
        invoke('tileContext:getAll', [workspaceId, tileId, tagPrefix]) as Promise<TileContextEntry[]>
      ),
      set: (workspaceId: string, tileId: string, key: string, value: unknown) => (
        invoke('tileContext:set', [workspaceId, tileId, key, value]) as Promise<boolean>
      ),
      delete: (workspaceId: string, tileId: string, key: string) => (
        invoke('tileContext:delete', [workspaceId, tileId, key]) as Promise<boolean>
      ),
      onChanged: (workspaceId: string, tileId: string, callback: (data: TileContextChangedPayload) => void) => eventHub.on('tileContext:changed', payload => {
        if (isTileContextChangeForScope(payload, workspaceId, tileId)) callback(payload)
      }),
    },
    image: {
      edit: makeInvoker(invoke, 'image:edit'),
    },
    extActions: {
      onAction: makeEventListener(eventHub, 'ext:action'),
    },
    canvas: {
      load: makeInvoker(invoke, 'canvas:load'),
      save: makeInvoker(invoke, 'canvas:save'),
      loadTileState: makeInvoker(invoke, 'canvas:loadTileState'),
      saveTileState: makeInvoker(invoke, 'canvas:saveTileState'),
      clearTileState: makeInvoker(invoke, 'canvas:clearTileState'),
      deleteTileArtifacts: makeInvoker(invoke, 'canvas:deleteTileArtifacts'),
      listSessions: makeInvoker(invoke, 'canvas:listSessions'),
      onSessionsChanged: makeEventListener(eventHub, 'canvas:sessionsChanged'),
      getSessionState: makeInvoker(invoke, 'canvas:getSessionState'),
      deleteSession: makeInvoker(invoke, 'canvas:deleteSession'),
      setSessionArchived: makeInvoker(invoke, 'canvas:setSessionArchived'),
      renameSession: makeInvoker(invoke, 'canvas:renameSession'),
      generateSessionTitle: makeInvoker(invoke, 'canvas:generateSessionTitle'),
      listCheckpoints: makeInvoker(invoke, 'canvas:listCheckpoints'),
      restoreCheckpoint: makeInvoker(invoke, 'canvas:restoreCheckpoint'),
      queuedMessages: {
        append: makeInvoker(invoke, 'canvas:queuedMessages:append'),
        listActive: makeInvoker(invoke, 'canvas:queuedMessages:listActive'),
      },
    },
    threads: {
      indexStatus: makeInvoker(invoke, 'threads:indexStatus'),
      reindex: makeInvoker(invoke, 'threads:reindex'),
      onIndexUpdated: makeEventListener(eventHub, 'threads:indexUpdated'),
    },
    kanban: {
      load: makeInvoker(invoke, 'kanban:load'),
      save: makeInvoker(invoke, 'kanban:save'),
    },
    terminal: {
      // Bun's terminal host authorizes workspaceDir (not the renderer's
      // workspace id) and accepts the shared Electron six-argument contract.
      // Keep this as an explicit adapter so provider CLI handoff reaches the
      // PTY with the correct cwd, executable, and resume args.
      create: (
        tileId: string,
        workspaceId: string,
        workspaceDir: string,
        launchBin?: string,
        launchArgs?: string[],
        options?: { cols?: number; rows?: number },
      ) => invoke('terminal:create', [tileId, workspaceId, workspaceDir, launchBin, launchArgs, options]),
      write: makeInvoker(invoke, 'terminal:write'),
      cd: makeInvoker(invoke, 'terminal:cd'),
      resize: makeInvoker(invoke, 'terminal:resize'),
      destroy: makeInvoker(invoke, 'terminal:destroy'),
      detach: makeInvoker(invoke, 'terminal:detach'),
      updatePeers: makeInvoker(invoke, 'terminal:update-peers'),
      onData: (tileId: string, callback: (data: string) => void) => eventHub.on(`terminal:data:${tileId}`, payload => callback(String(payload ?? ''))),
      onActive: (tileId: string, callback: () => void) => eventHub.on(`terminal:active:${tileId}`, () => callback()),
      onExit: (tileId: string, callback: (exitCode: number) => void) => eventHub.on(`terminal:exit:${tileId}`, payload => callback(Number(payload ?? 0))),
    },
    agents: {
      detect: makeInvoker(invoke, 'agents:detect'),
    },
    agentPaths: {
      get: makeInvoker(invoke, 'agentPaths:get'),
      detect: makeInvoker(invoke, 'agentPaths:detect'),
      set: makeInvoker(invoke, 'agentPaths:set'),
      needsSetup: makeInvoker(invoke, 'agentPaths:needsSetup'),
      confirmAll: makeInvoker(invoke, 'agentPaths:confirmAll'),
    },
    chat: {
      send: makeInvoker(invoke, 'chat:send'),
      resumeJob: makeInvoker(invoke, 'chat:resumeJob'),
      steer: makeInvoker(invoke, 'chat:steer'),
      stop: makeInvoker(invoke, 'chat:stop'),
      clearSession: makeInvoker(invoke, 'chat:clearSession'),
      disposeCard: makeInvoker(invoke, 'chat:disposeCard'),
      opencodeModels: makeInvoker(invoke, 'chat:opencodeModels'),
      gatewayModels: makeInvoker(invoke, 'chat:gatewayModels'),
      onOpencodeModelsUpdated: makeEventListener(eventHub, 'chat:opencodeModelsUpdated'),
      onGatewayModelsUpdated: makeEventListener(eventHub, 'chat:gatewayModelsUpdated'),
      openclawAgents: makeInvoker(invoke, 'chat:openclawAgents'),
      csagentModels: makeInvoker(invoke, 'chat:csagentModels'),
      selectFiles: makeInvoker(invoke, 'chat:selectFiles'),
      // The browser bridge cannot prove that a renderer-supplied File carries
      // a native path. Fail closed and let the UI direct users to the
      // host-owned picker, which issues scoped one-shot capabilities.
      authorizeDroppedFiles: async () => [],
      writeTempAttachment: makeInvoker(invoke, 'chat:writeTempAttachment'),
      revokeAttachmentSelections: makeInvoker(invoke, 'chat:revokeAttachmentSelections'),
      answerUserQuestion: makeInvoker(invoke, 'chat:answerUserQuestion'),
      answerToolPermission: makeInvoker(invoke, 'chat:answerToolPermission'),
      setPermissionMode: makeInvoker(invoke, 'chat:setPermissionMode'),
      loadSessionHistory: makeInvoker(invoke, 'chat:loadSessionHistory'),
    },
    stream: {
      start: makeInvoker(invoke, 'stream:start'),
      stop: makeInvoker(invoke, 'stream:stop'),
      onChunk: makeEventListener(eventHub, 'agent:stream'),
    },
    git: {
      status: makeInvoker(invoke, 'git:status'),
      branches: makeInvoker(invoke, 'git:branches'),
      checkoutBranch: makeInvoker(invoke, 'git:checkoutBranch'),
      createBranch: makeInvoker(invoke, 'git:createBranch'),
    },
    window: {
      new: makeInvoker(invoke, 'window:new'),
      openDevSandbox: makeInvoker(invoke, 'window:openDevSandbox'),
      newTab: makeInvoker(invoke, 'window:newTab'),
      newWorkspaceTab: makeInvoker(invoke, 'window:newWorkspaceTab'),
      list: makeInvoker(invoke, 'window:list'),
      getCurrentId: makeInvoker(invoke, 'window:getCurrentId'),
      setTitle: makeInvoker(invoke, 'window:setTitle'),
      focusById: makeInvoker(invoke, 'window:focusById'),
      closeById: makeInvoker(invoke, 'window:closeById'),
      openMiniChat: makeInvoker(invoke, 'window:openMiniChat'),
      setSidebarCollapsed: makeInvoker(invoke, 'window:setSidebarCollapsed'),
      onListChanged: makeEventListener(eventHub, 'window:list-changed'),
      isFresh: makeInvoker(invoke, 'window:isFresh'),
      onNewTab: (callback: () => void) => eventHub.on('workspace:newTab', () => callback()),
    },
    app: {
      relaunch: makeInvoker(invoke, 'app:relaunch'),
    },
    execution: {
      listHosts: makeInvoker(invoke, 'execution:listHosts'),
      upsertHost: makeInvoker(invoke, 'execution:upsertHost'),
      deleteHost: makeInvoker(invoke, 'execution:deleteHost'),
      resolveTarget: makeInvoker(invoke, 'execution:resolveTarget'),
    },
    dreaming: {
      status: makeInvoker(invoke, 'dreaming:status'),
      listRuns: makeInvoker(invoke, 'dreaming:listRuns'),
      run: makeInvoker(invoke, 'dreaming:run'),
      cancel: makeInvoker(invoke, 'dreaming:cancel'),
    },
    shell: {
      openExternal: makeInvoker(invoke, 'shell:openExternal'),
    },
    browserTile: {
      sync: makeInvoker(invoke, 'browserTile:sync'),
      command: makeInvoker(invoke, 'browserTile:command'),
      destroy: makeInvoker(invoke, 'browserTile:destroy'),
      setFrameRate: makeInvoker(invoke, 'webview:setFrameRate'),
      onEvent: makeEventListener(eventHub, 'browserTile:event'),
      onNewWindow: makeEventListener(eventHub, 'webview:new-window'),
    },
    owl: {
      health: makeInvoker(invoke, 'owl:health'),
      createSession: makeInvoker(invoke, 'owl:session:create'),
      createProfile: makeInvoker(invoke, 'owl:profile:create'),
      createWebView: makeInvoker(invoke, 'owl:webview:create'),
      navigate: makeInvoker(invoke, 'owl:webview:navigate'),
      setGeometry: makeInvoker(invoke, 'owl:webview:setGeometry'),
      dispatchInput: makeInvoker(invoke, 'owl:webview:dispatchInput'),
      capture: makeInvoker(invoke, 'owl:webview:capture'),
      destroy: makeInvoker(invoke, 'owl:webview:destroy'),
      stop: makeInvoker(invoke, 'owl:stop'),
    },
    chromeSync: {
      listProfiles: makeInvoker(invoke, 'chromeSync:listProfiles'),
      getStatus: makeInvoker(invoke, 'chromeSync:getStatus'),
      syncCookies: makeInvoker(invoke, 'chromeSync:syncCookies'),
      getBookmarks: makeInvoker(invoke, 'chromeSync:getBookmarks'),
      searchHistory: makeInvoker(invoke, 'chromeSync:searchHistory'),
    },
    localProxy: {
      start: makeInvoker(invoke, 'localProxy:start'),
      stop: makeInvoker(invoke, 'localProxy:stop'),
      getStatus: makeInvoker(invoke, 'localProxy:getStatus'),
      probeBackends: makeInvoker(invoke, 'localProxy:probeBackends'),
    },
    settings: {
      get: makeInvoker(invoke, 'settings:get'),
      set: makeInvoker(invoke, 'settings:set'),
      getRawJson: makeInvoker(invoke, 'settings:getRawJson'),
      setRawJson: makeInvoker(invoke, 'settings:setRawJson'),
      validateGenerationProvider: makeInvoker(invoke, 'settings:validateGenerationProvider'),
    },
    permissions: {
      list: makeInvoker(invoke, 'permissions:list'),
      clear: makeInvoker(invoke, 'permissions:clear'),
      clearAll: makeInvoker(invoke, 'permissions:clearAll'),
    },
    jobs: {
      recent: makeInvoker(invoke, 'jobs:recent'),
    },
    updater: {
      check: makeInvoker(invoke, 'updater:check'),
      download: makeInvoker(invoke, 'updater:download'),
      quitAndInstall: makeInvoker(invoke, 'updater:quitAndInstall'),
    },
    mcp: {
      getPort: makeInvoker(invoke, 'mcp:getPort'),
      getToken: makeInvoker(invoke, 'mcp:getToken'),
      getConfig: makeInvoker(invoke, 'mcp:getConfig'),
      saveServers: makeInvoker(invoke, 'mcp:saveServers'),
      getWorkspaceServers: makeInvoker(invoke, 'mcp:getWorkspaceServers'),
      saveWorkspaceServers: makeInvoker(invoke, 'mcp:saveWorkspaceServers'),
      getMergedConfig: makeInvoker(invoke, 'mcp:getMergedConfig'),
      onKanban: (callback: (event: string, data: unknown) => void) => eventHub.on('mcp:kanban', payload => {
        const msg = payload as { event?: string, data?: unknown }
        callback(String(msg?.event ?? ''), msg?.data)
      }),
      onInject: (callback: (cardId: string, message: string, appendNewline: boolean) => void) => eventHub.on('mcp:inject', payload => {
        const msg = payload as { cardId?: string, message?: string, appendNewline?: boolean }
        callback(String(msg?.cardId ?? ''), String(msg?.message ?? ''), Boolean(msg?.appendNewline))
      }),
      inject: (cardId: string, message: string) => invoke('terminal:write', [cardId, `${message}\r`]),
    },
    activity: {
      upsert: makeInvoker(invoke, 'activity:upsert'),
      query: makeInvoker(invoke, 'activity:query'),
      byTile: makeInvoker(invoke, 'activity:byTile'),
      delete: makeInvoker(invoke, 'activity:delete'),
      clearTile: makeInvoker(invoke, 'activity:clearTile'),
      byAgent: makeInvoker(invoke, 'activity:byAgent'),
      health: makeInvoker(invoke, 'activity:health'),
    },
    collab: {
      ensureDir: makeInvoker(invoke, 'collab:ensureDir'),
      writeObjective: makeInvoker(invoke, 'collab:writeObjective'),
      readObjective: makeInvoker(invoke, 'collab:readObjective'),
      writeSkills: makeInvoker(invoke, 'collab:writeSkills'),
      readSkills: makeInvoker(invoke, 'collab:readSkills'),
      writeState: makeInvoker(invoke, 'collab:writeState'),
      readState: makeInvoker(invoke, 'collab:readState'),
      addContext: makeInvoker(invoke, 'collab:addContext'),
      removeContext: makeInvoker(invoke, 'collab:removeContext'),
      listContext: makeInvoker(invoke, 'collab:listContext'),
      readContext: makeInvoker(invoke, 'collab:readContext'),
      listMessages: makeInvoker(invoke, 'collab:listMessages'),
      readMessage: makeInvoker(invoke, 'collab:readMessage'),
      sendMessage: makeInvoker(invoke, 'collab:sendMessage'),
      updateMessageStatus: makeInvoker(invoke, 'collab:updateMessageStatus'),
      moveMessage: makeInvoker(invoke, 'collab:moveMessage'),
      watchState: makeInvoker(invoke, 'collab:watchState'),
      unwatchState: makeInvoker(invoke, 'collab:unwatchState'),
      watchMessages: makeInvoker(invoke, 'collab:watchMessages'),
      unwatchMessages: makeInvoker(invoke, 'collab:unwatchMessages'),
      removeTileDir: makeInvoker(invoke, 'collab:removeTileDir'),
      pruneOrphanedTileDirs: makeInvoker(invoke, 'collab:pruneOrphanedTileDirs'),
      onStateChanged: makeEventListener(eventHub, 'collab:stateChanged'),
      onMessageChanged: makeEventListener(eventHub, 'collab:messageChanged'),
    },
    relay: {
      init: makeInvoker(invoke, 'relay:init'),
      syncWorkspace: makeInvoker(invoke, 'relay:syncWorkspace'),
      listParticipants: makeInvoker(invoke, 'relay:listParticipants'),
      listChannels: makeInvoker(invoke, 'relay:listChannels'),
      listCentralFeed: makeInvoker(invoke, 'relay:listCentralFeed'),
      listMessages: makeInvoker(invoke, 'relay:listMessages'),
      readMessage: makeInvoker(invoke, 'relay:readMessage'),
      sendDirectMessage: makeInvoker(invoke, 'relay:sendDirectMessage'),
      sendChannelMessage: makeInvoker(invoke, 'relay:sendChannelMessage'),
      updateMessageStatus: makeInvoker(invoke, 'relay:updateMessageStatus'),
      moveMessage: makeInvoker(invoke, 'relay:moveMessage'),
      setWorkContext: makeInvoker(invoke, 'relay:setWorkContext'),
      analyzeRelationships: makeInvoker(invoke, 'relay:analyzeRelationships'),
      spawnAgent: makeInvoker(invoke, 'relay:spawnAgent'),
      stopAgent: makeInvoker(invoke, 'relay:stopAgent'),
      waitForReady: makeInvoker(invoke, 'relay:waitForReady'),
      waitForAny: makeInvoker(invoke, 'relay:waitForAny'),
      onEvent: makeEventListener(eventHub, 'relay:event'),
    },
    extensions: {
      list: makeInvoker(invoke, 'ext:list'),
      listSidebar: makeInvoker(invoke, 'ext:list-sidebar'),
      listTiles: makeInvoker(invoke, 'ext:list-tiles'),
      listChatSurfaces: makeInvoker(invoke, 'ext:list-chat-surfaces'),
      tileEntry: makeInvoker(invoke, 'ext:tile-entry'),
      chatSurfaceEntry: makeInvoker(invoke, 'ext:chat-surface-entry'),
      getBridgeScript: makeInvoker(invoke, 'ext:get-bridge-script'),
      enable: makeInvoker(invoke, 'ext:enable'),
      disable: makeInvoker(invoke, 'ext:disable'),
      refresh: makeInvoker(invoke, 'ext:refresh'),
      invoke: (extId: string, method: string, ...args: unknown[]) => invoke(`ext:${extId}:${method}`, args),
      capabilityGate: makeInvoker(invoke, 'ext:capability-gate'),
      installFromFile: makeInvoker(invoke, 'ext:install-from-file'),
      contributions: makeInvoker(invoke, 'ext:contributions'),
      surfaceHtml: makeInvoker(invoke, 'ext:surface-html'),
      storeGet: makeInvoker(invoke, 'ext:store-get'),
      storeSet: makeInvoker(invoke, 'ext:store-set'),
      storeReplace: makeInvoker(invoke, 'ext:store-replace'),
      getSettings: makeInvoker(invoke, 'ext:settings-get'),
      setSettings: makeInvoker(invoke, 'ext:settings-set'),
      contextMenuItems: makeInvoker(invoke, 'ext:context-menu-items'),
    },
    bus: {
      publish: makeInvoker(invoke, 'bus:publish'),
      subscribe: (channel: string, subscriberId: string, callback: (event: any) => void) => {
        void invoke('bus:subscribe', [channel, subscriberId])
        const off = makeFilteredBusListener(eventHub, channel, callback)
        return () => {
          off()
          void invoke('bus:unsubscribeAll', [subscriberId])
        }
      },
      unsubscribeAll: makeInvoker(invoke, 'bus:unsubscribeAll'),
      history: makeInvoker(invoke, 'bus:history'),
      channelInfo: makeInvoker(invoke, 'bus:channelInfo'),
      unreadCount: makeInvoker(invoke, 'bus:unreadCount'),
      markRead: makeInvoker(invoke, 'bus:markRead'),
      onEvent: (callback: (event: any) => void) => eventHub.on('bus:event', payload => callback(payload)),
    },
    db: {
      status: makeInvoker(invoke, 'db:status'),
      reset: makeInvoker(invoke, 'db:reset'),
    },
    system: {
      cleanupTile: makeInvoker(invoke, 'system:cleanupTile'),
      gc: makeInvoker(invoke, 'system:gc'),
      memStats: makeInvoker(invoke, 'system:memStats'),
      daemonStatus: makeInvoker(invoke, 'system:daemonStatus'),
      daemonSummary: makeInvoker(invoke, 'system:daemonSummary'),
      restartDaemon: makeInvoker(invoke, 'system:restartDaemon'),
      requestMediaAccess: makeInvoker(invoke, 'system:requestMediaAccess'),
      onGcRequested: (callback: () => void) => eventHub.on('system:gc-requested', () => callback()),
    },
    homedir: options.homedir,
    platform: options.platform,
    getPathForFile: (file: File & { path?: string }) => file?.path ?? '',
    zoom: {
      getLevel: () => zoomLevel,
      setLevel: async (level: number) => {
        zoomLevel = Number.isFinite(level) ? level : 0
        await invoke('ui:setZoomLevel', [zoomLevel])
      },
    },
    perf: {
      getEnv: (): Record<string, string> => ({}),
    },
    transcribe: {
      run: makeInvoker(invoke, 'transcribe:run'),
    },
    tts: {
      synthesize: makeInvoker(invoke, 'tts:synthesize'),
    },
    spokify: {
      run: makeInvoker(invoke, 'spokify:run'),
    },
    secrets: {
      set: makeInvoker(invoke, 'secrets:set'),
      delete: makeInvoker(invoke, 'secrets:delete'),
      list: makeInvoker(invoke, 'secrets:list'),
      has: makeInvoker(invoke, 'secrets:has'),
    },
    pets: {
      list: makeInvoker(invoke, 'pets:list'),
      gallery: makeInvoker(invoke, 'pets:gallery'),
      galleryLocal: makeInvoker(invoke, 'pets:gallery-local'),
      install: makeInvoker(invoke, 'pets:install'),
      remove: makeInvoker(invoke, 'pets:remove'),
      thumbnail: makeInvoker(invoke, 'pets:thumbnail'),
      thumbnailData: makeInvoker(invoke, 'pets:thumbnailData'),
      spritesheetData: makeInvoker(invoke, 'pets:spritesheetData'),
      getManifest: makeInvoker(invoke, 'pets:getManifest'),
      onGalleryChanged: makeEventListener(eventHub, 'pets:gallery-changed'),
    },
  }
}

export function detectPlatformFromUserAgent(userAgent: string): string {
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'darwin'
  if (/Windows/i.test(userAgent)) return 'win32'
  if (/Linux/i.test(userAgent)) return 'linux'
  return 'browser'
}

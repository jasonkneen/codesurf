/// <reference types="vite/client" />

 import type { AggregatedSessionEntry } from '../../shared/session-types'
 import type { ExecutionHostRecord, ExecutionPreference, Workspace, ProjectRecord } from '../../shared/types'

interface ElectronAPI {
  appearance: {
    shouldUseDark(): Promise<boolean>
    setThemeSource(mode: 'dark' | 'light' | 'system'): Promise<boolean>
    onUpdated(callback: (payload: { shouldUseDark: boolean }) => void): () => void
  }
  workspace: {
    list(): Promise<Workspace[]>
    listProjects?(): Promise<ProjectRecord[]>
    create(name: string): Promise<Workspace>
    createWithPath(name: string, projectPath: string): Promise<Workspace>
    createFromFolder(folderPath: string): Promise<Workspace>
    addProjectFolder(workspaceId: string, folderPath: string): Promise<Workspace | null>
    removeProjectFolder(workspaceId: string, folderPath: string): Promise<Workspace | null>
    openFolder(): Promise<string | null>
    setActive(id: string): Promise<void>
    getActive(): Promise<Workspace | null>
    delete(id: string): Promise<void>
  }
  fs: {
    readDir(path: string): Promise<Array<{ name: string; path: string; isDir: boolean; ext: string }>>
    readFile(path: string): Promise<string>
    writeFile(path: string, content: string): Promise<void>
    createFile(path: string): Promise<void>
    createDir(path: string): Promise<void>
    deleteFile(path: string): Promise<void>
    delete(path: string): Promise<void>
    rename(oldPath: string, newPath: string): Promise<void>
    renameFile(oldPath: string, newPath: string): Promise<void>
    basename(path: string): Promise<string>
    revealInFinder?(path: string): Promise<void>
    writeBrief(cardId: string, content: string): Promise<string>
    stat(path: string): Promise<{ size: number; mtimeMs: number; isFile: boolean; isDir: boolean } | null>
    isProbablyTextFile(path: string): Promise<boolean>
    copyIntoDir(sourcePath: string, destDir: string): Promise<{ path: string }>
    watch(dirPath: string, callback: () => void): () => void
  }
  git?: {
    status(dirPath: string): Promise<{ isRepo: boolean; root: string; files: Array<{ path: string; status: string }> }>
    branches(dirPath: string): Promise<{ isRepo: boolean; root: string; current: string | null; branches: Array<{ name: string; current: boolean }> }>
    checkoutBranch(dirPath: string, branchName: string): Promise<{ ok: boolean; error?: string }>
    createBranch(dirPath: string, branchName: string): Promise<{ ok: boolean; error?: string }>
  }
  stream?: {
    start(req: { cardId: string; agentId: string; url: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<void>
    stop(cardId: string): Promise<void>
    onChunk(cb: (event: { cardId: string; type: string; text?: string; toolName?: string; error?: string }) => void): () => void
  }
  mcp?: {
    getPort(): Promise<number>
    getConfig(): Promise<unknown>
    saveServers(servers: Record<string, unknown>): Promise<void>
    getWorkspaceServers(workspaceId: string): Promise<Record<string, unknown>>
    saveWorkspaceServers(workspaceId: string, servers: Record<string, unknown>): Promise<void>
    getMergedConfig(workspaceId: string): Promise<unknown>
    onKanban(cb: (event: string, data: unknown) => void): () => void
    onInject(cb: (cardId: string, message: string, appendNewline: boolean) => void): () => void
    inject(cardId: string, message: string): Promise<void>
  }
  chat?: {
    send(req: unknown): Promise<{ ok: boolean; jobId?: string; detached?: boolean }>
    resumeJob?(req: unknown): Promise<{ ok: boolean; resumed?: boolean; jobId?: string | null }>
    stop(cardId: string): Promise<void>
    clearSession(cardId: string): Promise<{ ok: boolean }>
    opencodeModels(): Promise<{ models: Array<{ id: string; label: string; description?: string }>; source?: string; loading?: boolean }>
    onOpencodeModelsUpdated(cb: (payload: { models: Array<{ id: string; label: string; description?: string }>; source: string; error?: string }) => void): () => void
    openclawAgents(): Promise<{ agents: Array<{ id: string; label: string; description?: string }> }>
    selectFiles(): Promise<string[]>
  }
  shell?: {
    openExternal(url: string): Promise<void>
  }
  app?: {
    relaunch(): Promise<void>
  }
  execution: {
    listHosts(): Promise<ExecutionHostRecord[]>
    upsertHost(host: ExecutionHostRecord): Promise<ExecutionHostRecord[]>
    deleteHost(id: string): Promise<{ ok: true; hosts: ExecutionHostRecord[] }>
    resolveTarget(preference: ExecutionPreference): Promise<{
      host: ExecutionHostRecord
      fallback: boolean
      reason: string
    }>
  }
  window: {
    new(): Promise<void>
    newTab(): Promise<void>
    isFresh(): Promise<boolean>
    list(): Promise<{ id: number; title: string; focused: boolean }[]>
    getCurrentId(): Promise<number>
    setTitle(title: string): Promise<void>
    focusById(id: number): Promise<void>
    closeById(id: number): Promise<void>
    setSidebarCollapsed(collapsed: boolean): Promise<boolean>
    onListChanged(cb: (list: { id: number; title: string; focused: boolean }[]) => void): () => void
  }
  canvas: {
    load(workspaceId: string): Promise<import('../../shared/types').CanvasState | null>
    save(workspaceId: string, state: import('../../shared/types').CanvasState): Promise<void>
    loadTileState(workspaceId: string, tileId: string): Promise<any>
    saveTileState(workspaceId: string, tileId: string, state: any): Promise<void>
    clearTileState(workspaceId: string, tileId: string): Promise<void>
    deleteTileArtifacts(workspaceId: string, tileId: string): Promise<void>
    listSessions(workspaceId: string, forceRefresh?: boolean): Promise<AggregatedSessionEntry[]>
    onSessionsChanged(cb: (payload: { workspaceId: string }) => void): () => void
    getSessionState(workspaceId: string, sessionEntryId: string): Promise<any>
    deleteSession(workspaceId: string, sessionEntryId: string): Promise<{ ok: boolean; error?: string }>
    renameSession(workspaceId: string, sessionEntryId: string, title: string): Promise<{ ok: boolean; error?: string; title?: string }>
  }
  kanban?: {
    load(workspaceId: string, tileId: string): Promise<{ columns: Array<{ id: string; title: string }>; cards: import('./components/KanbanCard').KanbanCardData[] } | null>
    save(workspaceId: string, tileId: string, state: { columns: Array<{ id: string; title: string }>; cards: import('./components/KanbanCard').KanbanCardData[] }): Promise<void>
  }
  terminal: {
    create(tileId: string, workspaceDir: string, launchBin?: string, launchArgs?: string[]): Promise<{ cols: number; rows: number; buffer?: string }>
    write(tileId: string, data: string): Promise<void>
    resize(tileId: string, cols: number, rows: number): Promise<void>
    destroy(tileId: string): Promise<void>
    detach(tileId: string): Promise<void>
    updatePeers(tileId: string, workspaceDir: string, peers: Array<{ peerId: string; peerType: string; tools: string[] }>): Promise<void>
    onData(tileId: string, cb: (data: string) => void): () => void
    onActive(tileId: string, cb: () => void): () => void
  }
  browserTile: {
    sync(payload: { tileId: string; url: string; mode: 'desktop' | 'mobile'; zIndex: number; visible: boolean; bounds: { left: number; top: number; width: number; height: number } }): Promise<unknown>
    command(payload: { tileId: string; command: 'back' | 'forward' | 'reload' | 'stop' | 'home' | 'navigate' | 'mode'; url?: string; mode?: 'desktop' | 'mobile' }): Promise<unknown>
    destroy(tileId: string): Promise<void>
    onEvent(cb: (event: { tileId: string; currentUrl: string; canGoBack: boolean; canGoForward: boolean; isLoading: boolean; mode: 'desktop' | 'mobile' }) => void): () => void
  }
  agents: {
    detect(): Promise<Array<{ id: string; label: string; cmd: string; path?: string; version?: string; available: boolean }>>
  }
  updater: {
    check(): Promise<{ ok: boolean; currentVersion: string; status: string; updateAvailable: boolean; updateInfo?: { version?: string; releaseName?: string; releaseDate?: string } }>
    download(): Promise<{ ok: boolean; status: string }>
    quitAndInstall(): Promise<{ ok: boolean }>
  }
  settings: {
    get(): Promise<import('../../shared/types').AppSettings>
    set(settings: import('../../shared/types').AppSettings): Promise<import('../../shared/types').AppSettings>
    getRawJson(): Promise<{ path: string; content: string }>
    setRawJson(json: string): Promise<{ ok: boolean; error?: string; settings?: import('../../shared/types').AppSettings }>
  }
  permissions: {
    list(): Promise<{ path: string; grants: import('../../shared/types').ToolPermissionGrant[] }>
    clear(id: string): Promise<{ path: string; grants: import('../../shared/types').ToolPermissionGrant[] }>
    clearAll(): Promise<{ path: string; grants: import('../../shared/types').ToolPermissionGrant[] }>
  }
  activity: {
    upsert(workspaceId: string, data: {
      id?: string
      tileId: string
      type: 'task' | 'tool' | 'skill' | 'context'
      status?: 'pending' | 'running' | 'done' | 'error' | 'paused'
      title: string
      detail?: string
      metadata?: Record<string, unknown>
      agent?: string
    }): Promise<unknown>
    query(query: {
      workspaceId: string
      tileId?: string
      type?: string
      status?: string
      agent?: string
      limit?: number
    }): Promise<unknown[]>
    byTile(workspaceId: string, tileId: string): Promise<unknown[]>
    delete(workspaceId: string, id: string): Promise<boolean>
    clearTile(workspaceId: string, tileId: string): Promise<number>
    byAgent(workspaceId: string): Promise<Record<string, unknown[]>>
  }
  collab: {
    ensureDir(workspacePath: string, tileId: string): Promise<boolean>
    writeObjective(workspacePath: string, tileId: string, md: string): Promise<boolean>
    readObjective(workspacePath: string, tileId: string): Promise<string | null>
    writeSkills(workspacePath: string, tileId: string, skills: { enabled: string[]; disabled: string[] }): Promise<boolean>
    readSkills(workspacePath: string, tileId: string): Promise<{ enabled: string[]; disabled: string[] }>
    writeState(workspacePath: string, tileId: string, state: any): Promise<boolean>
    readState(workspacePath: string, tileId: string): Promise<any>
    addContext(workspacePath: string, tileId: string, filename: string, content: string): Promise<boolean>
    removeContext(workspacePath: string, tileId: string, filename: string): Promise<boolean>
    listContext(workspacePath: string, tileId: string): Promise<string[]>
    readContext(workspacePath: string, tileId: string, filename: string): Promise<string | null>
    listMessages(workspacePath: string, tileId: string, mailbox: import('../../shared/types').CollabMailbox): Promise<import('../../shared/types').CollabMessageListItem[]>
    readMessage(workspacePath: string, tileId: string, mailbox: import('../../shared/types').CollabMailbox, filename: string): Promise<import('../../shared/types').CollabMessage | null>
    sendMessage(workspacePath: string, fromTileId: string, draft: import('../../shared/types').CollabMessageDraft): Promise<{ id: string; threadId: string; filename: string; fromTileId: string; toTileId: string; senderPath: string; recipientPath: string }>
    updateMessageStatus(workspacePath: string, tileId: string, mailbox: import('../../shared/types').CollabMailbox, filename: string, status: import('../../shared/types').CollabMessageStatus): Promise<boolean>
    moveMessage(workspacePath: string, tileId: string, fromMailbox: import('../../shared/types').CollabMailbox, toMailbox: import('../../shared/types').CollabMailbox, filename: string): Promise<boolean>
    watchState(workspacePath: string, tileId: string): Promise<boolean>
    unwatchState(workspacePath: string, tileId: string): Promise<boolean>
    watchMessages(workspacePath: string, tileId: string): Promise<boolean>
    unwatchMessages(workspacePath: string, tileId: string): Promise<boolean>
    removeTileDir(workspacePath: string, tileId: string): Promise<boolean>
    pruneOrphanedTileDirs(workspacePath: string, tileIds: string[]): Promise<{ removed: string[] }>
    onStateChanged(callback: (data: { workspacePath: string; tileId: string; state: any }) => void): () => void
    onMessageChanged(callback: (data: { workspacePath: string; tileId: string; mailbox: import('../../shared/types').CollabMailbox; filename: string; event: 'add' | 'change' | 'unlink'; message?: import('../../shared/types').CollabMessage | null }) => void): () => void
  }
  relay: {
    init(workspacePath: string): Promise<boolean>
    syncWorkspace(workspaceId: string, workspacePath: string, tiles: import('../../shared/types').TileState[]): Promise<unknown[]>
    listParticipants(workspacePath: string): Promise<import('../../../packages/contex-relay/src').RelayParticipant[]>
    listChannels(workspacePath: string): Promise<import('../../../packages/contex-relay/src').RelayChannel[]>
    listCentralFeed(workspacePath: string, limit?: number): Promise<import('../../../packages/contex-relay/src').RelayMessageListItem[]>
    listMessages(workspacePath: string, participantId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', limit?: number): Promise<import('../../../packages/contex-relay/src').RelayMessageListItem[]>
    readMessage(workspacePath: string, participantId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string): Promise<import('../../../packages/contex-relay/src').RelayMessage | null>
    sendDirectMessage(workspacePath: string, from: string, draft: import('../../../packages/contex-relay/src').RelayDirectMessageDraft): Promise<import('../../../packages/contex-relay/src').RelayMessage>
    sendChannelMessage(workspacePath: string, from: string, draft: import('../../../packages/contex-relay/src').RelayChannelMessageDraft): Promise<import('../../../packages/contex-relay/src').RelayMessage>
    updateMessageStatus(workspacePath: string, participantId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string, status: import('../../../packages/contex-relay/src').RelayMessageStatus): Promise<boolean>
    moveMessage(workspacePath: string, participantId: string, fromMailbox: 'inbox' | 'sent' | 'memory' | 'bin', toMailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string): Promise<boolean>
    setWorkContext(workspacePath: string, participantId: string, work: import('../../../packages/contex-relay/src').RelayWorkContext): Promise<import('../../../packages/contex-relay/src').RelayParticipant>
    analyzeRelationships(workspacePath: string): Promise<import('../../../packages/contex-relay/src').RelayRelationshipHint[]>
    spawnAgent(workspacePath: string, request: import('../../../packages/contex-relay/src').RelaySpawnRequest): Promise<import('../../../packages/contex-relay/src').RelayParticipant>
    stopAgent(workspacePath: string, participantId: string): Promise<boolean>
    waitForReady(workspacePath: string, ids: string[], timeoutMs?: number): Promise<boolean>
    waitForAny(workspacePath: string, ids: string[], timeoutMs?: number): Promise<import('../../../packages/contex-relay/src').RelayParticipant>
    onEvent(callback: (data: { workspacePath: string; event: import('../../../packages/contex-relay/src').RelayEvent }) => void): () => void
  }
  extensions: {
    list(): Promise<Array<{ id: string; name: string; version: string; description?: string; author?: string; tier: 'safe' | 'power'; ui?: import('../../shared/types').ExtensionManifest['ui']; enabled: boolean; contributes?: import('../../shared/types').ExtensionManifest['contributes'] }>>
    listSidebar(workspacePath?: string | null): Promise<{
      entries: Array<{ id: string; name: string }>
      tiles: import('../../shared/types').ExtensionTileContrib[]
    }>
    listTiles(): Promise<import('../../shared/types').ExtensionTileContrib[]>
    tileEntry(extId: string, tileType: string, tileId?: string): Promise<string | null>
    getBridgeScript(tileId: string, extId: string): Promise<string>
    enable(extId: string): Promise<boolean>
    disable(extId: string): Promise<boolean>
    refresh(workspacePath?: string | null): Promise<Array<{ id: string; name: string; version: string; description?: string; author?: string; tier: 'safe' | 'power'; ui?: import('../../shared/types').ExtensionManifest['ui']; enabled: boolean; contributes?: import('../../shared/types').ExtensionManifest['contributes'] }>>
    invoke(extId: string, method: string, ...args: unknown[]): Promise<unknown>
    getSettings(extId: string): Promise<Record<string, unknown>>
    setSettings(extId: string, settings: Record<string, unknown>): Promise<boolean>
    contextMenuItems(): Promise<import('../../shared/types').ExtensionContextMenuContrib[]>
  }
  chromeSync: {
    listProfiles(): Promise<Array<{ name: string; dir: string; email?: string; avatarIcon?: string }>>
    getStatus(settings: { enabled: boolean; profileDir: string | null }): Promise<{ enabled: boolean; profileDir: string | null; lastSync: number | null; profiles: Array<{ name: string; dir: string; email?: string }> }>
    syncCookies(profileDir: string, partition: string): Promise<{ count: number; errors: string[] }>
    getBookmarks(profileDir: string): Promise<unknown[]>
    searchHistory(profileDir: string, query: string, limit?: number): Promise<Array<{ url: string; title: string; visitCount: number; lastVisitTime: number }>>
  }
  homedir: string
  platform: NodeJS.Platform
  bus: {
    publish(channel: string, type: string, source: string, payload: Record<string, unknown>): Promise<import('../../shared/types').BusEvent>
    subscribe(channel: string, subscriberId: string, callback: (event: import('../../shared/types').BusEvent) => void): () => void
    unsubscribeAll(subscriberId: string): Promise<void>
    history(channel: string, limit?: number): Promise<import('../../shared/types').BusEvent[]>
    channelInfo(channel: string): Promise<import('../../shared/types').ChannelInfo>
    unreadCount(channel: string, subscriberId: string): Promise<number>
    markRead(channel: string, subscriberId: string): Promise<void>
    onEvent(callback: (event: import('../../shared/types').BusEvent) => void): () => void
  }
  zoom: {
    getLevel(): number
    setLevel(level: number): void
  }
  getPathForFile(file: File): string
  system: {
    cleanupTile(tileId: string): Promise<{ ok: boolean; channelsDropped?: number }>
    gc(): Promise<{ ok: boolean; exposed: boolean }>
    memStats(): Promise<{
      rss: number
      heapTotal: number
      heapUsed: number
      heapLimit: number
      external: number
      arrayBuffers: number
      bus: { channels: number; events: number; subscriptions: number; readCursors: number }
    }>
    daemonStatus(): Promise<{
      running: boolean
      info: {
        pid: number
        port: number
        startedAt: string
        protocolVersion: number
        appVersion: string | null
      } | null
    }>
    daemonSummary(): Promise<{
      running: boolean
      info: {
        pid: number
        port: number
        startedAt: string
        protocolVersion: number
        appVersion: string | null
      } | null
      jobs: {
        total: number
        active: number
        backgroundActive: number
        completed: number
        failed: number
        cancelled: number
        other: number
        recent: Array<{
          id: string
          taskLabel: string | null
          status: string
          runMode: string | null
          workspaceId: string | null
          cardId: string | null
          provider: string | null
          model: string | null
          workspaceDir: string | null
          sessionId: string | null
          initialPrompt: string | null
          updatedAt: string | null
          requestedAt: string | null
          lastSequence: number
          error: string | null
        }>
      }
    }>
    restartDaemon(): Promise<{
      running: boolean
      info: {
        pid: number
        port: number
        startedAt: string
        protocolVersion: number
        appVersion: string | null
      } | null
    }>
    onGcRequested(callback: () => void): () => void
  }
}

declare global {
  const __VERSION__: string
  interface Window {
    electron: ElectronAPI
  }

  // Allow <webview> tag in JSX (Electron webview)
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        useragent?: string
        partition?: string
        allowpopups?: string | boolean
        ref?: React.Ref<Electron.WebviewTag>
        style?: React.CSSProperties
      }
    }
  }
}

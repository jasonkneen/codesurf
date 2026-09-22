/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
/// <reference types="vite-plugin-pwa/react" />

// Electron frameless-window drag regions. `-webkit-app-region` is a real,
// Chromium-supported style key but is absent from @types/react's CSSProperties;
// declaring it once here removes every per-site suppression workaround.
declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag' | 'none'
  }
}


 import type { AggregatedSessionEntry, SessionEntryHint } from '../../shared/session-types'
 import type { ActivityHealthSnapshot, ActivityQuery, ActivityRecord, ActivityUpsertInput, ExecutionHostRecord, ExecutionPreference, Workspace, ProjectRecord, DashboardDreamingSummary } from '../../shared/types'

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
    renameProject(args: { projectId?: string; projectPath?: string; name: string }): Promise<{ ok: boolean; error?: string; project?: ProjectRecord }>
    createProjectWorktree(args: { projectId?: string; projectPath?: string; name: string; branch?: string }): Promise<{ ok: boolean; error?: string; project?: ProjectRecord; path?: string; branch?: string }>
    openFolder(): Promise<string | null>
    setActive(id: string): Promise<void>
    getActive(): Promise<Workspace | null>
    delete(id: string): Promise<void>
  }
  fs: {
    readDir(path: string, workspaceId?: string): Promise<Array<{ name: string; path: string; isDir: boolean; ext: string }>>
    readFile(path: string, workspaceId?: string): Promise<string>
    readFilePrefix(path: string, maxBytes: number, workspaceId?: string): Promise<string>
    writeFile(path: string, content: string, workspaceId?: string): Promise<void>
    createFile(path: string, workspaceId?: string): Promise<void>
    createDir(path: string, workspaceId?: string): Promise<void>
    deleteFile(path: string, workspaceId?: string): Promise<void>
    renameFile(oldPath: string, newPath: string, workspaceId?: string): Promise<void>
    revealInFinder?(path: string, workspaceId?: string): Promise<void>
    writeBrief(cardId: string, content: string): Promise<string>
    stat(path: string, workspaceId?: string): Promise<{ size: number; mtimeMs: number; isFile: boolean; isDir: boolean } | null>
    probeDir(path: string, workspaceId?: string): Promise<{ ok: true } | { ok: false, code: string }>
    isProbablyTextFile(path: string, workspaceId?: string): Promise<boolean>
    copyIntoDir(sourcePath: string, destDir: string, workspaceId?: string): Promise<{ path: string }>
    selectDir(): Promise<string | null>
    watch(dirPath: string, callback: () => void, workspaceId?: string): () => void
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
    onChunk(cb: (event: {
      workspaceId: string
      cardId: string
      jobId?: string
      sequence?: number
      type: string
      text?: string
      toolName?: string
      error?: string
      [key: string]: unknown
    }) => void): () => void
  }
  mcp?: {
    getPort(): Promise<number>
    getToken(): Promise<string>
    getConfig(): Promise<unknown>
    saveServers(servers: Record<string, unknown>): Promise<void>
    getWorkspaceServers(workspaceId: string): Promise<Record<string, unknown>>
    saveWorkspaceServers(workspaceId: string, servers: Record<string, unknown>): Promise<void>
    getMergedConfig(workspaceId: string): Promise<unknown>
    onKanban(cb: (event: string, data: unknown) => void): () => void
    onInject(cb: (workspaceId: string, cardId: string, message: string, appendNewline: boolean) => void): () => void
    inject(cardId: string, message: string): Promise<void>
  }
  tileContext?: {
    get(workspaceId: string, tileId: string, key?: string): Promise<unknown>
    getAll(workspaceId: string, tileId: string, tagPrefix?: string): Promise<Array<{ key: string; value: unknown; updatedAt?: number; source?: string }>>
    set(workspaceId: string, tileId: string, key: string, value: unknown): Promise<boolean>
    delete(workspaceId: string, tileId: string, key: string): Promise<boolean>
    onChanged?(workspaceId: string, tileId: string, cb: (data: { workspaceId: string; tileId: string; key: string; value: unknown }) => void): () => void
  }
  image?: {
    edit(req: { workspaceId: string; tileId: string; prompt: string; provider?: string; model?: string; outputPath?: string }): Promise<{ ok: boolean; result?: string; error?: string }>
  }
  chat?: {
    send(req: unknown): Promise<{ ok: boolean; jobId?: string; detached?: boolean }>
    resumeJob?(req: unknown): Promise<{ ok: boolean; resumed?: boolean; jobId?: string | null }>
    steer?(payload: { workspaceId: string; cardId: string; message: string }): Promise<{ ok: boolean; error?: string }>
    stop(workspaceId: string, cardId: string): Promise<{ ok: boolean; error?: string }>
    clearSession(workspaceId: string, cardId: string): Promise<{ ok: boolean; error?: string }>
    disposeCard(workspaceId: string, cardId: string): Promise<{ ok: boolean }>
    opencodeModels(): Promise<{ models: Array<{ id: string; label: string; description?: string }>; source?: string; loading?: boolean }>
    onOpencodeModelsUpdated(cb: (payload: { models: Array<{ id: string; label: string; description?: string }>; source: string; error?: string }) => void): () => void
    gatewayModels(): Promise<{ models: Array<{ id: string; label: string; description?: string }>; source?: string; error?: string }>
    onGatewayModelsUpdated(cb: (payload: { models: Array<{ id: string; label: string; description?: string }>; source: string; error?: string }) => void): () => void
    openclawAgents(): Promise<{ agents: Array<{ id: string; label: string; description?: string }> }>
    csagentModels(): Promise<{ models: Array<{ id: string; label: string; description?: string }>; error?: string }>
    selectFiles(workspaceId: string, cardId: string): Promise<Array<{ capability: string; displayName: string }>>
    authorizeDroppedFiles(workspaceId: string, cardId: string, files: File[]): Promise<Array<{ capability: string; displayName: string }>>
    writeTempAttachment(payload: { workspaceId: string; cardId: string; data: string; mime?: string; ext?: string; filenameHint?: string }): Promise<{ ok: true; attachment: { capability: string; displayName: string } } | { ok: false; error: string }>
    answerUserQuestion(payload: {
      workspaceId: string
      cardId: string
      toolId: string | null
      answers: Record<string, string>
      annotations?: Record<string, { notes?: string; preview?: string }>
    }): Promise<{ ok: boolean; error?: string }>
    answerToolPermission(payload: {
      workspaceId: string
      cardId: string
      toolId: string | null
      // `never` persists a deny-grant so subsequent calls auto-reject.
      decision: 'deny' | 'never' | 'once' | 'session' | 'today' | 'forever'
    }): Promise<{ ok: boolean; error?: string }>
    setPermissionMode(payload: { workspaceId: string; cardId: string; mode: string }): Promise<{ ok: boolean; error?: string }>
    loadSessionHistory(payload: {
      workspaceId?: string
      sessionEntryId?: string
      entryHint?: SessionEntryHint | null
      beforeFingerprint?: string | null
      limit?: number
    }): Promise<{
      ok: boolean
      error?: string
      total?: number
      hasMore?: boolean
      provider?: string
      model?: string
      sessionId?: string | null
      messages: import('../../shared/chat-types').ChatMessage[]
    }>
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
  dreaming: {
    status(workspaceId: string): Promise<{
      workspaceId: string
      running: boolean
      activeRun: {
        id: string
        workspaceId: string
        workspaceName: string | null
        workspaceDir: string
        provider: string
        model: string
        status: string
        requestedAt: string
        startedAt: string
        completedAt: string | null
        sessionsReviewed: number
        reviewedSessionIds: string[]
        latestSessionUpdatedAt: string | null
        outputPath: string | null
        artifactPath: string | null
        summary: string | null
        promptPreview: string | null
        error: string | null
      } | null
      lastRun: {
        id: string
        workspaceId: string
        workspaceName: string | null
        workspaceDir: string
        provider: string
        model: string
        status: string
        requestedAt: string
        startedAt: string
        completedAt: string | null
        sessionsReviewed: number
        reviewedSessionIds: string[]
        latestSessionUpdatedAt: string | null
        outputPath: string | null
        artifactPath: string | null
        summary: string | null
        promptPreview: string | null
        error: string | null
      } | null
      state: {
        workspaceId: string
        lastRunId: string | null
        lastCompletedAt: string | null
        lastSuccessfulRunId: string | null
        lastSuccessfulCompletedAt: string | null
        lastReviewedAt: string | null
        latestMemoryPath: string | null
      }
    }>
    listRuns(args: { workspaceId: string; limit?: number }): Promise<{
      workspaceId: string
      runs: Array<{
        id: string
        workspaceId: string
        workspaceName: string | null
        workspaceDir: string
        provider: string
        model: string
        status: string
        requestedAt: string
        startedAt: string
        completedAt: string | null
        sessionsReviewed: number
        reviewedSessionIds: string[]
        latestSessionUpdatedAt: string | null
        outputPath: string | null
        artifactPath: string | null
        summary: string | null
        promptPreview: string | null
        error: string | null
      }>
    }>
    run(args: { workspaceId: string; provider?: string; model?: string; maxSessions?: number }): Promise<{
      started: boolean
      run: {
        id: string
        workspaceId: string
        workspaceName: string | null
        workspaceDir: string
        provider: string
        model: string
        status: string
        requestedAt: string
        startedAt: string
        completedAt: string | null
        sessionsReviewed: number
        reviewedSessionIds: string[]
        latestSessionUpdatedAt: string | null
        outputPath: string | null
        artifactPath: string | null
        summary: string | null
        promptPreview: string | null
        error: string | null
      }
    }>
    cancel(args: { workspaceId: string; runId?: string | null }): Promise<{ ok: boolean; error?: string }>
  }
  window: {
    new(): Promise<void>
    openDevSandbox(): Promise<null>
    newTab(): Promise<void>
    newWorkspaceTab(workspaceId?: string | null): Promise<{ id: number }>
    isFresh(): Promise<boolean>
    list(): Promise<{ id: number; title: string; focused: boolean }[]>
    getCurrentId(): Promise<number>
    setTitle(title: string): Promise<void>
    focusById(id: number): Promise<void>
    closeById(id: number): Promise<void>
    openMiniChat(opts: { workspaceId: string; tileId: string; title?: string }): Promise<{ ok: boolean; id?: number; error?: string }>
    setSidebarCollapsed(collapsed: boolean): Promise<boolean>
    onPersistenceRequest?(callback: (request: {
      nonce: string
      reason: 'close' | 'quit' | 'reload' | 'force-reload'
      canvasOwner: boolean
    }) => void): () => void
    persistenceReady?(nonce: string): void
    onListChanged(cb: (list: { id: number; title: string; focused: boolean }[]) => void): () => void
    onNewTab(cb: () => void): () => void
  }
  canvas: {
    load(workspaceId: string): Promise<import('../../shared/types').CanvasState | null>
    save(workspaceId: string, state: import('../../shared/types').CanvasState): Promise<void>
    loadTileState<T = unknown>(workspaceId: string, tileId: string): Promise<T>
    saveTileState(workspaceId: string, tileId: string, state: unknown): Promise<void>
    clearTileState(workspaceId: string, tileId: string): Promise<void>
    deleteTileArtifacts(workspaceId: string, tileId: string): Promise<void>
    listSessions(workspaceId: string, forceRefresh?: boolean): Promise<AggregatedSessionEntry[]>
    onSessionsChanged(cb: (payload: { workspaceId: string }) => void): () => void
    getSessionState(
      workspaceId: string,
      sessionEntryId: string,
      options?: {
        tailLimit?: number
        entryHint?: SessionEntryHint | null
      },
    ): Promise<unknown>
    deleteSession(workspaceId: string, sessionEntryId: string): Promise<{ ok: boolean; error?: string }>
    setSessionArchived(workspaceId: string, sessionEntryId: string, archived: boolean, identityKey?: string | null): Promise<{ ok: boolean; changed?: boolean; archived?: boolean; error?: string }>
    renameSession(workspaceId: string, sessionEntryId: string, title: string): Promise<{ ok: boolean; error?: string; title?: string }>
    generateSessionTitle(workspaceId: string, sessionEntryId: string, entryHint?: SessionEntryHint | null): Promise<{ ok: boolean; error?: string; title?: string }>
    listCheckpoints(workspaceId: string, sessionEntryId: string): Promise<Array<{ id: string; sessionEntryId: string; createdAt: string; restoredAt?: string | null; label: string; reason?: string | null; fileCount: number; files: string[] }>>
    restoreCheckpoint(workspaceId: string, checkpointId: string, sessionEntryId?: string): Promise<{ ok: boolean; checkpoint?: { id: string }; filesRestored?: number; filesDeleted?: number; error?: string }>
  }
  kanban?: {
    load(workspaceId: string, tileId: string): Promise<{ columns: Array<{ id: string; title: string }>; cards: import('./components/KanbanCard').KanbanCardData[] } | null>
    save(workspaceId: string, tileId: string, state: { columns: Array<{ id: string; title: string }>; cards: import('./components/KanbanCard').KanbanCardData[] }): Promise<void>
  }
  terminal: {
    create(tileId: string, workspaceId: string, workspaceDir: string, launchBin?: string, launchArgs?: string[], options?: { cols?: number; rows?: number }): Promise<{ cols: number; rows: number; buffer?: string }>
    write(tileId: string, data: string): Promise<void>
    resize(tileId: string, cols: number, rows: number): Promise<void>
    destroy(tileId: string, workspaceId: string): Promise<void>
    detach(tileId: string): Promise<void>
    updatePeers(tileId: string, workspaceId: string, workspaceDir: string, peers: Array<{ peerId: string; peerType: string; tools: string[] }>): Promise<void>
    onData(tileId: string, cb: (data: string) => void): () => void
    onActive(tileId: string, cb: () => void): () => void
    onExit(tileId: string, cb: (exitCode: number) => void): () => void
    cd?(tileId: string, dir: string): Promise<void>
  }
  browserTile: {
    sync(payload: { tileId: string; url: string; mode: 'desktop' | 'mobile'; zIndex: number; visible: boolean; bounds: { left: number; top: number; width: number; height: number } }): Promise<unknown>
    command(payload: { tileId: string; command: 'back' | 'forward' | 'reload' | 'stop' | 'home' | 'navigate' | 'mode'; url?: string; mode?: 'desktop' | 'mobile' }): Promise<unknown>
    destroy(tileId: string): Promise<void>
    /** Guest paint throttle: webContentsId from webview.getWebContentsId(), main applies setFrameRate. */
    setFrameRate?(webContentsId: number, fps: number): Promise<{ ok: boolean }>
    onEvent(cb: (event: { tileId: string; currentUrl: string; canGoBack: boolean; canGoForward: boolean; isLoading: boolean; mode: 'desktop' | 'mobile' }) => void): () => void
    onNewWindow(cb: (event: { url: string }) => void): () => void
  }
  owl: {
    health(): Promise<{ ok: true; runtime: 'electron'; pid: number }>
    createSession(options?: { appName?: string; buildFlavor?: string }): Promise<{ id: string; appName: string; createdAt: number; buildFlavor?: string }>
    createProfile(options: { sessionId: string; name?: string; persistent?: boolean; storageKey?: string; isolateForAgent?: boolean }): Promise<{ id: string; sessionId: string; name: string; persistent: boolean; partition: string; createdAt: number }>
    createWebView(options: { profileId: string; initialUrl?: string; width?: number; height?: number; deviceScaleFactor?: number; visible?: boolean }): Promise<{ id: string; profileId: string; url: string | null; width: number; height: number; deviceScaleFactor: number; visible: boolean; createdAt: number }>
    navigate(options: { webViewId: string; url: string }): Promise<{ id: string; profileId: string; url: string | null; width: number; height: number; deviceScaleFactor: number; visible: boolean; createdAt: number }>
    setGeometry(options: { webViewId: string; width: number; height: number; deviceScaleFactor?: number }): Promise<{ id: string; profileId: string; url: string | null; width: number; height: number; deviceScaleFactor: number; visible: boolean; createdAt: number }>
    dispatchInput(options: { webViewId: string; route?: 'content' | 'browser'; event: Record<string, unknown> }): Promise<{ accepted: boolean; returnedToClient: boolean }>
    capture(options: { webViewId: string; includePopups?: boolean }): Promise<{ webViewId: string; mimeType: 'image/png'; dataBase64: string; width: number; height: number }>
    destroy(webViewId: string): Promise<{ ok: true }>
    stop(): Promise<{ ok: true }>
  }
  agents: {
    detect(): Promise<Array<{ id: string; label: string; cmd: string; path?: string; version?: string; available: boolean }>>
  }
  agentPaths: {
    get(): Promise<Record<string, { path: string | null; version: string | null; detectedAt: string; confirmed: boolean }>>
    detect(): Promise<Record<string, { path: string | null; version: string | null; detectedAt: string; confirmed: boolean }>>
    set(agentId: string, path: string | null): Promise<{ ok: boolean; error?: string }>
    needsSetup(): Promise<boolean>
    confirmAll(): Promise<void>
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
    validateGenerationProvider(providerId: string, providerPatch?: Partial<import('../../shared/types').GenerationProviderSettings>): Promise<{
      ok: boolean
      providerId: string
      message: string
      models: Array<{ id: string; name: string; label: string; methods: string[]; capabilities: Array<'image' | 'video' | 'text'> }>
      textModels: Array<{ id: string; name: string; label: string; methods: string[]; capabilities: Array<'image' | 'video' | 'text'> }>
      imageModels: Array<{ id: string; name: string; label: string; methods: string[]; capabilities: Array<'image' | 'video' | 'text'> }>
      videoModels: Array<{ id: string; name: string; label: string; methods: string[]; capabilities: Array<'image' | 'video' | 'text'> }>
    }>
  }
  permissions: {
    list(): Promise<{ path: string; grants: import('../../shared/types').ToolPermissionGrant[] }>
    clear(id: string): Promise<{ path: string; grants: import('../../shared/types').ToolPermissionGrant[] }>
    clearAll(): Promise<{ path: string; grants: import('../../shared/types').ToolPermissionGrant[] }>
  }
  activity: {
    upsert(workspaceId: string, data: ActivityUpsertInput): Promise<ActivityRecord>
    query(query: ActivityQuery): Promise<ActivityRecord[]>
    byTile(workspaceId: string, tileId: string): Promise<ActivityRecord[]>
    delete(workspaceId: string, tileId: string, id: string): Promise<boolean>
    clearTile(workspaceId: string, tileId: string): Promise<number>
    byAgent(workspaceId: string): Promise<Record<string, ActivityRecord[]>>
    health(workspaceId: string): Promise<ActivityHealthSnapshot>
  }
  collab: {
    ensureDir(workspacePath: string, tileId: string): Promise<boolean>
    writeObjective(workspacePath: string, tileId: string, md: string): Promise<boolean>
    readObjective(workspacePath: string, tileId: string): Promise<string | null>
    writeSkills(workspacePath: string, tileId: string, skills: { enabled: string[]; disabled: string[] }): Promise<boolean>
    readSkills(workspacePath: string, tileId: string): Promise<{ enabled: string[]; disabled: string[] }>
    writeState(workspacePath: string, tileId: string, state: unknown): Promise<boolean>
    readState<T = unknown>(workspacePath: string, tileId: string): Promise<T>
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
    onStateChanged(callback: (data: { workspacePath: string; tileId: string; state: unknown }) => void): () => void
    onMessageChanged(callback: (data: { workspacePath: string; tileId: string; mailbox: import('../../shared/types').CollabMailbox; filename: string; event: 'add' | 'change' | 'unlink'; message?: import('../../shared/types').CollabMessage | null }) => void): () => void
  }
  relay: {
    init(workspacePath: string): Promise<boolean>
    syncWorkspace(workspaceId: string, workspacePath: string, tiles: import('../../shared/types').TileState[]): Promise<unknown[]>
    listParticipants(workspacePath: string): Promise<import('../../../packages/codesurf-relay/src').RelayParticipant[]>
    listChannels(workspacePath: string): Promise<import('../../../packages/codesurf-relay/src').RelayChannel[]>
    listCentralFeed(workspacePath: string, limit?: number): Promise<import('../../../packages/codesurf-relay/src').RelayMessageListItem[]>
    listMessages(workspacePath: string, participantId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', limit?: number): Promise<import('../../../packages/codesurf-relay/src').RelayMessageListItem[]>
    readMessage(workspacePath: string, participantId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string): Promise<import('../../../packages/codesurf-relay/src').RelayMessage | null>
    sendDirectMessage(workspacePath: string, from: string, draft: import('../../../packages/codesurf-relay/src').RelayDirectMessageDraft): Promise<import('../../../packages/codesurf-relay/src').RelayMessage>
    sendChannelMessage(workspacePath: string, from: string, draft: import('../../../packages/codesurf-relay/src').RelayChannelMessageDraft): Promise<import('../../../packages/codesurf-relay/src').RelayMessage>
    updateMessageStatus(workspacePath: string, participantId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string, status: import('../../../packages/codesurf-relay/src').RelayMessageStatus): Promise<boolean>
    moveMessage(workspacePath: string, participantId: string, fromMailbox: 'inbox' | 'sent' | 'memory' | 'bin', toMailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string): Promise<boolean>
    setWorkContext(workspacePath: string, participantId: string, work: import('../../../packages/codesurf-relay/src').RelayWorkContext): Promise<import('../../../packages/codesurf-relay/src').RelayParticipant>
    analyzeRelationships(workspacePath: string): Promise<import('../../../packages/codesurf-relay/src').RelayRelationshipHint[]>
    spawnAgent(workspacePath: string, request: import('../../../packages/codesurf-relay/src').RelaySpawnRequest): Promise<import('../../../packages/codesurf-relay/src').RelayParticipant>
    stopAgent(workspacePath: string, participantId: string): Promise<boolean>
    waitForReady(workspacePath: string, ids: string[], timeoutMs?: number): Promise<boolean>
    waitForAny(workspacePath: string, ids: string[], timeoutMs?: number): Promise<import('../../../packages/codesurf-relay/src').RelayParticipant>
    onEvent(callback: (data: { workspacePath: string; event: import('../../../packages/codesurf-relay/src').RelayEvent }) => void): () => void
  }
  extensions: {
    list(): Promise<Array<{ id: string; name: string; version: string; description?: string; author?: string; tier: 'safe' | 'power'; ui?: import('../../shared/types').ExtensionManifest['ui']; enabled: boolean; contributes?: import('../../shared/types').ExtensionManifest['contributes'] }>>
    listSidebar(workspacePath?: string | null): Promise<{
      entries: Array<{ id: string; name: string; icon?: string | null; enabled: boolean }>
      tiles: import('../../shared/types').ExtensionTileContrib[]
    }>
    listTiles(): Promise<import('../../shared/types').ExtensionTileContrib[]>
    listChatSurfaces(): Promise<Array<{
      extId: string
      id: string
      label: string
      description?: string
      icon?: string
      entry: string
      emits: 'image' | 'text'
      defaultHeight: number
      minHeight: number
      uiMode?: 'native' | 'custom'
    }>>
    tileEntry(extId: string, tileType: string, tileId?: string): Promise<string | null>
    chatSurfaceEntry(extId: string, surfaceId: string, instanceId?: string): Promise<string | null>
    getBridgeScript(tileId: string, extId: string): Promise<string>
    capabilityGate(extId: string): Promise<{ enforced: boolean; granted: string[] }>
    enable(extId: string): Promise<boolean>
    disable(extId: string): Promise<boolean>
    installFromFile(): Promise<{ ok: boolean; extId?: string; name?: string; error?: string; canceled?: boolean }>
    installVsix?(vsixPath: string): Promise<{ ok: boolean; extId?: string; name?: string; error?: string; tiles?: import('../../shared/types').ExtensionTileContrib[] }>
    refresh(workspacePath?: string | null): Promise<Array<{ id: string; name: string; version: string; description?: string; author?: string; tier: 'safe' | 'power'; ui?: import('../../shared/types').ExtensionManifest['ui']; enabled: boolean; contributes?: import('../../shared/types').ExtensionManifest['contributes'] }>>
    invoke(extId: string, method: string, ...args: unknown[]): Promise<unknown>
    getSettings(extId: string): Promise<Record<string, unknown>>
    setSettings(extId: string, settings: Record<string, unknown>): Promise<boolean>
    contextMenuItems(): Promise<import('../../shared/types').ExtensionContextMenuContrib[]>
    contributions(): Promise<{
      commands: Array<import('../../shared/types').ExtensionCommandContrib & { extId: string }>
      footer: Array<import('../../shared/types').ExtensionFooterContrib & { extId: string }>
      panels: Array<import('../../shared/types').ExtensionPanelContrib & { extId: string }>
      settingsSections: Array<import('../../shared/types').ExtensionSettingsSectionContrib & { extId: string }>
      layoutPresets: Array<import('../../shared/types').ExtensionLayoutPresetContrib & { extId: string }>
    }>
    contributions(kind: string): Promise<Array<{ extId: string } & Record<string, unknown>>>
    surfaceHtml(extId: string, kind: string, surfaceId: string): Promise<string | null>
    storeGet(extId: string): Promise<Record<string, unknown>>
    storeSet(extId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>
    storeReplace(extId: string, value: Record<string, unknown>): Promise<Record<string, unknown>>
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
  skills: {
    inspect(zipPath: string): Promise<{
      name: string
      description: string
      topFolder: string
      entryCount: number
      hasSkillMd: boolean
      preview: string
      zipPath: string
      sizeBytes: number
    }>
    install(args: { zipPath: string; targetDir?: string; overwrite?: boolean }): Promise<{
      installedPath: string
      entries: string[]
      targetDir: string
    }>
    getDefaultTargetDir(): Promise<string>
    ready(): Promise<boolean>
    onFileOpened(callback: (payload: { path: string }) => void): () => void
  }
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
    setLevel(level: number): Promise<void>
  }
  /** Canvas perf feature flags — CODESURF_PERF_* env vars, read once at startup. */
  perf: {
    getEnv(): Record<string, string>
  }
  /** Speech-to-text (dictation) — pluggable provider, audio captured renderer-side. */
  transcribe: {
    run(args: {
      audio: ArrayBuffer
      mimeType: string
      provider?: 'openai' | 'deepgram' | 'assemblyai' | 'local'
      lang?: string
      localBaseUrl?: string
      openaiModel?: string
      deepgramModel?: string
    }): Promise<{ ok: boolean; text?: string; error?: string }>
  }
  /** Text-to-speech — provider router on main side, returns audio bytes. */
  tts: {
    synthesize(args: {
      text: string
      provider?: 'cartesia' | 'deepgram' | 'elevenlabs' | 'voicelab' | 'say'
      voice?: string
      model?: string
      voiceLabBaseUrl?: string
      elevenModel?: string
      deepgramModel?: string
    }): Promise<{ ok: boolean; audio?: Uint8Array; mimeType?: string; error?: string }>
  }
  /** Spokify — rewrite assistant messages into natural spoken narration via LLM. */
  spokify: {
    run(args: { text: string; model?: string }): Promise<{ ok: boolean; text?: string; error?: string }>
  }
  /** Encrypted secrets storage (API keys). Renderer never reads decrypted values. */
  secrets: {
    set(name: string, value: string): Promise<{ ok: boolean; error?: string }>
    delete(name: string): Promise<{ ok: boolean; error?: string }>
    list(): Promise<{ ok: boolean; names: string[] }>
    has(name: string): Promise<{ ok: boolean; has: boolean }>
  }
  pets: {
    list(): Promise<import('../../shared/pet-types').PetListResponse>
    gallery(): Promise<import('../../shared/pet-types').PetGalleryResponse>
    galleryLocal(): Promise<import('../../shared/pet-types').PetGalleryResponse>
    install(slug: string): Promise<import('../../shared/pet-types').PetInstallResponse>
    remove(slug: string): Promise<import('../../shared/pet-types').PetRemoveResponse>
    thumbnail(slug: string): Promise<string | null>
    thumbnailData(slug: string): Promise<string | null>
    spritesheetData(slug: string): Promise<string | null>
    getManifest(slug: string): Promise<import('../../shared/pet-types').PetManifest | null>
    onGalleryChanged(callback: () => void): () => void
  }
  getPathForFile(file: File): string
  /** Local SQLite diagnostics. */
  db: {
    status(): Promise<
      | { ok: true; status: { path: string; deviceId: string; schemaVersion: number; tables: string[] } }
      | { ok: false; error: string }
    >
    reset(): Promise<{ ok: true; backupPath: string | null } | { ok: false; error: string }>
  }
  /** Thread index (phase 2). Powers the sidebar via SQLite instead of filesystem walks. */
  threads: {
    indexStatus(): Promise<
      | { ok: true; status: { workspacePath: string | null; seedingInFlight: boolean; lastSeedStartedAt: number; lastSeedFinishedAt: number; lastSeedDurationMs: number; lastSeedCount: number; totalRows: number; lastError: string | null; watcherCount: number } }
      | { ok: false; error: string }
    >
    reindex(workspaceId: string): Promise<{ ok: true; durationMs: number; count: number; tombstoned: number } | { ok: false; error: string }>
    onIndexUpdated(callback: (payload: { workspacePath: string | null; count: number; tombstoned: number; durationMs: number }) => void): () => void
  }
  system: {
    cleanupTile(workspaceId: string, tileId: string): Promise<{ ok: boolean; channelsDropped?: number }>
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
      dreaming: DashboardDreamingSummary | null
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
    requestMediaAccess?(args?: { kind?: 'microphone' | 'camera' }): Promise<{
      granted: boolean
      status: string
      openedSettings?: boolean
    }>
  }
}

declare global {
  const __VERSION__: string
  interface Window {
    electron: ElectronAPI
    /** Native SDK bridge; present only in the Native WebView shell. */
    zero?: {
      invoke?: (name: string, args?: unknown) => Promise<unknown>
    }
    /** Runtime-injected host/sandbox configuration. Never derive tokens from URLs. */
    __CODESURF_PLATFORM__?: 'electron' | 'native' | 'web'
    __CODESURF_HOST__?: string
    __CODESURF_HOST_TOKEN__?: string
    __CODESURF_TERMINAL_ENDPOINT__?: string
    __CODESURF_TERMINAL_TOKEN__?: string
    __CODESURF_CAPABILITIES__?: Record<string, boolean>
  }

  interface ImportMetaEnv {
    readonly VITE_CODESURF_HOST?: string
    readonly VITE_CODESURF_TERMINAL_ENDPOINT?: string
  }

  // Global `JSX` namespace shim → React.JSX.
  //
  // @types/react@19 dropped the global `JSX` namespace (it now lives under
  // `React.JSX`, and JSX *syntax* resolves via `react/jsx-runtime`). But this
  // codebase has ~58 files with bare `JSX.Element` / `JSX.IntrinsicElements`
  // type annotations that reference the GLOBAL `JSX` namespace. Previously that
  // global was supplied only transitively by `react-jsx-parser`'s nested
  // `@types/react@18`; removing that dependency (dup-04) deletes the global,
  // so we re-provide it here, mirroring `react/jsx-runtime`'s mapping exactly.
  // The Electron <webview> augmentation is folded into IntrinsicElements below.
  namespace JSX {
    type ElementType = React.JSX.ElementType
    interface Element extends React.JSX.Element {}
    interface ElementClass extends React.JSX.ElementClass {}
    interface ElementAttributesProperty extends React.JSX.ElementAttributesProperty {}
    interface ElementChildrenAttribute extends React.JSX.ElementChildrenAttribute {}
    type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<C, P>
    interface IntrinsicAttributes extends React.JSX.IntrinsicAttributes {}
    interface IntrinsicClassAttributes<T> extends React.JSX.IntrinsicClassAttributes<T> {}
    interface IntrinsicElements extends React.JSX.IntrinsicElements {
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

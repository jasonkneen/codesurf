/**
 * Install a `window.electron`-compatible facade backed by web-host + codesurfd.
 *
 * Used when the renderer runs outside Electron (browser or Native WebView).
 * Electron preload always installs first and is never overwritten.
 *
 * Capability matrix (see docs/multi-target.md):
 *  ✅ workspace, canvas, settings, chat jobs, sessions, basic fs
 *  ✅ terminal gateway sessions when a local or hosted sandbox is configured
 *  ⚠️ node-pty / extensions: Electron-only
 */

import { createHostHeaders, hostUrl } from './hostConfig.ts'
import { createTerminalTransport } from './terminalTransport.ts'

type Json = unknown

async function hostFetch<T = Json>(path: string, init?: RequestInit): Promise<T> {
  const headers = createHostHeaders(init?.headers)
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const res = await fetch(hostUrl(path), {
    ...init,
    headers,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `host request failed: ${res.status} ${path}`)
  }
  // Some host routes return raw null
  const text = await res.text()
  if (!text) return null as T
  return JSON.parse(text) as T
}

async function daemonFetch<T = Json>(path: string, init?: RequestInit): Promise<T> {
  // web-host injects daemon bearer token; browser never sees it
  const p = path.startsWith('/') ? path : `/${path}`
  return hostFetch<T>(`/d${p}`, init)
}

function noopUnsub(): () => void {
  return () => {}
}

function notAvailable(feature: string) {
  return async () => {
    console.warn(`[codesurf-platform] ${feature} is not available outside Electron yet`)
    throw new Error(`${feature} requires Electron (use npm run dev for full features)`)
  }
}

/**
 * Soft-fill missing methods on a host namespace so UI never crashes with
 * "x is not a function" when the web bridge is incomplete.
 * Known methods keep their implementations; unknown methods become async no-ops
 * (or unsub no-ops for `on*` listeners).
 */
function softNamespace<T extends object>(ns: string, base: T): T {
  return new Proxy(base as object, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      if (prop in (target as object)) {
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const name = String(prop)
      // Raw settings editing is intentionally Electron-only. Returning an
      // async no-op makes callers believe the capability exists and can lead
      // to a later write against the wrong persistence contract.
      if (ns === 'settings' && (name === 'getRawJson' || name === 'setRawJson')) return undefined
      // Event-style APIs: onFoo(cb) / subscribe → return unsubscribe
      if (name.startsWith('on') || name === 'subscribe' || name === 'watch' || name.startsWith('watch')) {
        return (..._args: unknown[]) => {
          console.debug(`[codesurf-platform] soft-stub ${ns}.${name} (listener)`)
          return noopUnsub()
        }
      }
      return async (..._args: unknown[]) => {
        console.debug(`[codesurf-platform] soft-stub ${ns}.${name}`)
        return undefined
      }
    },
  }) as T
}

/** Soft-fill missing top-level namespaces on the electron facade. */
function softElectronApi<T extends object>(base: T): T {
  return new Proxy(base as object, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      if (prop in (target as object)) {
        const value = Reflect.get(target, prop, receiver)
        // Soft-wrap plain object namespaces so nested missing methods are safe
        if (
          value
          && typeof value === 'object'
          && !Array.isArray(value)
          && typeof prop === 'string'
          && prop !== 'homedir'
          && prop !== 'platform'
        ) {
          return softNamespace(prop, value as object)
        }
        return typeof value === 'function' ? value.bind(target) : value
      }
      const name = String(prop)
      if (name.startsWith('on') || name === 'getPathForFile') {
        if (name === 'getPathForFile') return () => ''
        return (..._args: unknown[]) => noopUnsub()
      }
      // Unknown top-level namespace → soft empty object
      return softNamespace(name, {})
    },
  }) as T
}

/**
 * Build a partial ElectronAPI that covers bootstrap + collaborative core paths.
 */
export function createDaemonBackedElectronApi(): typeof window.electron {
  const busListeners = new Map<string, Set<(event: { channel: string; payload: unknown }) => void>>()
  const terminalTransport = createTerminalTransport()
  const streamListeners = new Set<(event: Record<string, unknown>) => void>()
  const activeJobStreams = new Map<string, {
    workspaceId: string
    cardId: string
    jobId: string
    controller: AbortController
  }>()
  const maxSseBufferBytes = 1024 * 1024
  const jobStreamKey = (workspaceId: string, cardId: string) =>
    JSON.stringify([workspaceId, cardId])

  const emitStreamEvent = (event: Record<string, unknown>) => {
    for (const listener of streamListeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[codesurf-platform] stream listener error', error)
      }
    }
  }

  const stopJobStream = (workspaceId: string, cardId: string) => {
    const key = jobStreamKey(workspaceId, cardId)
    const active = activeJobStreams.get(key)
    if (!active) return
    activeJobStreams.delete(key)
    active.controller.abort()
  }

  const drainSseEvents = (buffer: string): { events: Record<string, unknown>[], remaining: string } => {
    const events: Record<string, unknown>[] = []
    let remaining = buffer
    let boundary = remaining.search(/\r?\n\r?\n/)
    while (boundary >= 0) {
      const frame = remaining.slice(0, boundary)
      const separatorLength = remaining.startsWith('\r\n\r\n', boundary) ? 4 : 2
      remaining = remaining.slice(boundary + separatorLength)
      const data = frame
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n')
      if (data) {
        try {
          const event = JSON.parse(data)
          if (event && typeof event === 'object' && !Array.isArray(event)) {
            events.push(event as Record<string, unknown>)
          }
        } catch {
          // Ignore one malformed SSE frame; the next framed event is still
          // independently parseable and sequence-deduplicated by the UI.
        }
      }
      boundary = remaining.search(/\r?\n\r?\n/)
    }
    return { events, remaining }
  }

  const subscribeToJobEvents = async (
    workspaceId: string,
    cardId: string,
    jobId: string,
    since = 0,
  ): Promise<void> => {
    const key = jobStreamKey(workspaceId, cardId)
    stopJobStream(workspaceId, cardId)
    const controller = new AbortController()
    activeJobStreams.set(key, { workspaceId, cardId, jobId, controller })
    const query = new URLSearchParams({ jobId, since: String(Math.max(0, Math.floor(since))) })

    try {
      const response = await fetch(hostUrl(`/d/chat/job/events?${query.toString()}`), {
        headers: createHostHeaders({ Accept: 'text/event-stream' }),
        // Hosted same-origin proxies retain their session cookie. Local Vite
        // and Native bridges authenticate explicitly with X-Codesurf-Host, so
        // this must not turn into a credentialed cross-origin CORS request.
        credentials: 'same-origin',
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        const detail = (await response.text().catch(() => '')).trim().slice(0, 300)
        throw new Error(detail || `Daemon event stream failed (${response.status})`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        if (buffer.length > maxSseBufferBytes) {
          throw new Error('Daemon event stream exceeded its buffered-event limit')
        }
        const parsed = drainSseEvents(buffer)
        buffer = parsed.remaining
        for (const event of parsed.events) {
          emitStreamEvent({
            ...event,
            workspaceId,
            cardId,
            jobId: typeof event.jobId === 'string' ? event.jobId : jobId,
          })
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        emitStreamEvent({
          workspaceId,
          cardId,
          jobId,
          type: 'error',
          error: error instanceof Error ? error.message : 'Daemon event stream failed',
        })
      }
    } finally {
      const active = activeJobStreams.get(key)
      if (active?.controller === controller) activeJobStreams.delete(key)
    }
  }

  const api = {
    appearance: {
      shouldUseDark: async () => {
        if (typeof window !== 'undefined' && window.matchMedia) {
          return window.matchMedia('(prefers-color-scheme: dark)').matches
        }
        return true
      },
      setThemeSource: async () => true,
      onUpdated: (callback: (payload: { shouldUseDark: boolean }) => void) => {
        if (typeof window === 'undefined' || !window.matchMedia) return noopUnsub()
        const mq = window.matchMedia('(prefers-color-scheme: dark)')
        const handler = () => callback({ shouldUseDark: mq.matches })
        mq.addEventListener?.('change', handler)
        return () => mq.removeEventListener?.('change', handler)
      },
    },

    workspace: {
      list: () => daemonFetch('/workspace/list'),
      listProjects: () => daemonFetch('/workspace/projects'),
      create: (name: string) => daemonFetch('/workspace/create', { method: 'POST', body: JSON.stringify({ name }) }),
      createWithPath: (name: string, projectPath: string) =>
        daemonFetch('/workspace/create-with-path', { method: 'POST', body: JSON.stringify({ name, projectPath }) }),
      createFromFolder: (folderPath: string) =>
        daemonFetch('/workspace/create-from-folder', { method: 'POST', body: JSON.stringify({ folderPath }) }),
      addProjectFolder: (workspaceId: string, folderPath: string) =>
        daemonFetch('/workspace/add-project-folder', { method: 'POST', body: JSON.stringify({ workspaceId, folderPath }) }),
      removeProjectFolder: (workspaceId: string, folderPath: string) =>
        daemonFetch('/workspace/remove-project-folder', { method: 'POST', body: JSON.stringify({ workspaceId, folderPath }) }),
      renameProject: (args: { projectId?: string; projectPath?: string; name: string }) =>
        daemonFetch('/workspace/project/rename', { method: 'POST', body: JSON.stringify(args) }),
      createProjectWorktree: (args: { projectId?: string; projectPath?: string; name: string; branch?: string }) =>
        daemonFetch('/workspace/project/worktree', { method: 'POST', body: JSON.stringify(args) }),
      openFolder: async () => {
        // Never window.prompt — OS / browser file-access dialogs only.
        // See pickFolder.ts: zero → host native dialog → showDirectoryPicker.
        const { pickProjectFolderPath } = await import('./pickFolder')
        const result = await pickProjectFolderPath('Choose project folder')
        return result.path
      },
      delete: async (id: string) => {
        await daemonFetch(`/workspace/${encodeURIComponent(id)}`, { method: 'DELETE' })
      },
      setActive: async (id: string) => {
        await daemonFetch('/workspace/set-active', { method: 'POST', body: JSON.stringify({ id }) })
      },
      getActive: () => daemonFetch('/workspace/active'),
    },

    fs: {
      readDir: async (path: string) => {
        try {
          return await hostFetch(`/host/fs/readDir?path=${encodeURIComponent(path)}`)
        } catch {
          return []
        }
      },
      readFile: async (path: string) => {
        try {
          const res = await hostFetch<{ content?: string; missing?: boolean }>(
            `/host/fs/readFile?path=${encodeURIComponent(path)}`,
          )
          if (res?.missing) {
            const err = new Error(`ENOENT: ${path}`) as Error & { code?: string }
            err.code = 'ENOENT'
            throw err
          }
          return res.content ?? ''
        } catch (err) {
          // Missing optional config files (skills.json, etc.) should not crash UI.
          const msg = String((err as Error)?.message || err)
          if (msg.includes('ENOENT') || msg.includes('no such file')) {
            const e = new Error(msg) as Error & { code?: string }
            e.code = 'ENOENT'
            throw e
          }
          throw err
        }
      },
      readFilePrefix: async (path: string, maxBytes: number) => {
        const res = await hostFetch<{ content?: string; missing?: boolean }>(
          `/host/fs/readFilePrefix?path=${encodeURIComponent(path)}&maxBytes=${encodeURIComponent(String(maxBytes))}`,
        )
        if (res?.missing) {
          const err = new Error(`ENOENT: ${path}`) as Error & { code?: string }
          err.code = 'ENOENT'
          throw err
        }
        return res.content ?? ''
      },
      writeFile: async (path: string, content: string) => {
        await hostFetch('/host/fs/writeFile', { method: 'POST', body: JSON.stringify({ path, content }) })
      },
      createFile: async (path: string) => {
        await hostFetch('/host/fs/writeFile', { method: 'POST', body: JSON.stringify({ path, content: '' }) })
      },
      createDir: async (path: string) => {
        await hostFetch('/host/fs/mkdir', { method: 'POST', body: JSON.stringify({ path }) })
      },
      deleteFile: async (path: string) => {
        await hostFetch('/host/fs/remove', { method: 'POST', body: JSON.stringify({ path }) }).catch(() => {})
      },
      delete: async (path: string) => {
        await hostFetch('/host/fs/remove', { method: 'POST', body: JSON.stringify({ path }) }).catch(() => {})
      },
      rename: notAvailable('fs.rename'),
      renameFile: notAvailable('fs.renameFile'),
      basename: async (path: string) => {
        const res = await hostFetch<{ name: string }>(`/host/fs/basename?path=${encodeURIComponent(path)}`)
        return res.name
      },
      revealInFinder: async () => {},
      writeBrief: notAvailable('fs.writeBrief'),
      stat: (path: string) => hostFetch(`/host/fs/stat?path=${encodeURIComponent(path)}`),
      probeDir: async (path: string) => {
        try {
          const st = await hostFetch<{ isDir?: boolean } | null>(`/host/fs/stat?path=${encodeURIComponent(path)}`)
          if (st?.isDir) return { ok: true as const }
          return { ok: false as const, code: 'ENOTDIR' }
        } catch {
          return { ok: false as const, code: 'ENOENT' }
        }
      },
      isProbablyTextFile: async () => true,
      copyIntoDir: notAvailable('fs.copyIntoDir'),
      watch: () => noopUnsub(),
      selectDir: async () => api.workspace.openFolder(),
    },

    canvas: {
      load: (workspaceId: string) =>
        hostFetch(`/host/canvas/load?workspaceId=${encodeURIComponent(workspaceId)}`),
      save: async (workspaceId: string, state: unknown) => {
        await hostFetch('/host/canvas/save', {
          method: 'POST',
          body: JSON.stringify({ workspaceId, state }),
        })
      },
      loadTileState: (workspaceId: string, tileId: string) =>
        hostFetch(`/host/canvas/tile?workspaceId=${encodeURIComponent(workspaceId)}&tileId=${encodeURIComponent(tileId)}`),
      saveTileState: async (workspaceId: string, tileId: string, state: unknown) => {
        await hostFetch('/host/canvas/tile', {
          method: 'POST',
          body: JSON.stringify({ workspaceId, tileId, state }),
        })
      },
      clearTileState: async () => {},
      deleteTileArtifacts: async () => {},
      listSessions: async (workspaceId: string, forceRefresh?: boolean) => {
        try {
          return await daemonFetch(`/session/local/list?workspaceId=${encodeURIComponent(workspaceId)}${forceRefresh ? '&force=1' : ''}`)
        } catch {
          return []
        }
      },
      onSessionsChanged: () => noopUnsub(),
      getSessionState: async (workspaceId: string, sessionEntryId: string) =>
        daemonFetch(`/session/local/state?workspaceId=${encodeURIComponent(workspaceId)}&sessionEntryId=${encodeURIComponent(sessionEntryId)}`),
      deleteSession: async (workspaceId: string, sessionEntryId: string) =>
        daemonFetch('/session/local/delete', { method: 'POST', body: JSON.stringify({ workspaceId, sessionEntryId }) }),
      setSessionArchived: async () => {},
      renameSession: async (workspaceId: string, sessionEntryId: string, title: string) =>
        daemonFetch('/session/local/rename', { method: 'POST', body: JSON.stringify({ workspaceId, sessionEntryId, title }) }),
      generateSessionTitle: async () => null,
      listCheckpoints: async (workspaceId: string, sessionEntryId: string) =>
        daemonFetch('/checkpoint/list', { method: 'POST', body: JSON.stringify({ workspaceId, sessionEntryId }) }),
      restoreCheckpoint: async (workspaceId: string, checkpointId: string, sessionEntryId?: string) =>
        daemonFetch('/checkpoint/restore', { method: 'POST', body: JSON.stringify({ workspaceId, checkpointId, sessionEntryId }) }),
      queuedMessages: {
        append: async () => {},
        listActive: async () => [],
      },
    },

    settings: {
      // Settings are daemon-owned. Going through /d preserves its versioned
      // `{ version, settings }` file contract instead of treating the raw file
      // as an AppSettings object in the web host.
      get: () => daemonFetch('/settings'),
      set: async (next: unknown) => {
        return daemonFetch('/settings', { method: 'POST', body: JSON.stringify({ settings: next }) })
      },
    },

    window: {
      isFresh: async () => false,
      setSidebarCollapsed: async () => {},
      minimize: async () => {},
      maximize: async () => {},
      close: async () => {},
      // The soft namespace proxy synthesizes unknown methods. Keep lifecycle
      // capability keys explicit so feature detection sees that browser/native
      // hosts cannot delay close for a renderer persistence acknowledgement.
      onPersistenceRequest: undefined,
      persistenceReady: undefined,
    },

    bus: {
      publish: async (channel: string, payload: unknown) => {
        const set = busListeners.get(channel)
        if (set) {
          for (const cb of set) {
            try {
              cb({ channel, payload })
            } catch (err) {
              console.error('[codesurf-platform] bus listener error', err)
            }
          }
        }
      },
      subscribe: (_channel: string, _subscriberId: string, callback: (event: { channel: string; payload: unknown }) => void) => {
        const channel = _channel
        if (!busListeners.has(channel)) busListeners.set(channel, new Set())
        busListeners.get(channel)!.add(callback)
        return () => busListeners.get(channel)?.delete(callback)
      },
    },

    shell: {
      openExternal: async (href: string) => {
        const w = window as Window & { zero?: { invoke?: (name: string, args?: unknown) => Promise<unknown> } }
        if (w.zero?.invoke) {
          try {
            await w.zero.invoke('native-sdk.os.openUrl', { url: href })
            return
          } catch {
            // fall through
          }
        }
        window.open(href, '_blank', 'noopener,noreferrer')
      },
    },

    chat: {
      gatewayModels: async () =>
        daemonFetch<{ models: Array<{ id: string; label: string; description?: string }>; source?: string; error?: string }>('/chat/gateway-models'),
      send: async (req: unknown) => {
        const state = await daemonFetch<{ id?: string; jobId?: string }>('/chat/job/start', {
          method: 'POST',
          body: JSON.stringify({ request: req }),
        })
        const jobId = state.jobId || state.id
        const request = req && typeof req === 'object' ? req as Record<string, unknown> : {}
        const workspaceId = typeof request.workspaceId === 'string' ? request.workspaceId : ''
        const cardId = typeof request.cardId === 'string' ? request.cardId : ''
        const detached = request.runMode === 'background'
        if (jobId && workspaceId && cardId && !detached) {
          void subscribeToJobEvents(workspaceId, cardId, jobId)
        }
        return { ok: true, jobId, detached }
      },
      resumeJob: async (req: unknown) => {
        const request = req && typeof req === 'object' ? req as Record<string, unknown> : {}
        const workspaceId = typeof request.workspaceId === 'string' ? request.workspaceId : ''
        const cardId = typeof request.cardId === 'string' ? request.cardId : ''
        const jobId = typeof request.jobId === 'string' ? request.jobId : ''
        if (!workspaceId || !cardId || !jobId) {
          return { ok: false, resumed: false, jobId: jobId || null }
        }

        const state = await daemonFetch<{
          id?: string
          status?: string
          lastSequence?: number
          error?: string | null
          sessionId?: string | null
          workspaceId?: string | null
          cardId?: string | null
        }>(`/chat/job/state?jobId=${encodeURIComponent(jobId)}`)
        if (
          state.id !== jobId
          || state.workspaceId !== workspaceId
          || state.cardId !== cardId
        ) {
          return { ok: false, resumed: false, jobId }
        }
        const since = typeof request.jobSequence === 'number' && Number.isFinite(request.jobSequence)
          ? Math.max(0, Math.floor(request.jobSequence))
          : 0
        const lastSequence = Number(state.lastSequence ?? 0)
        const active = state.status === 'queued' || state.status === 'running'
        if (!active && since >= lastSequence) {
          if (state.error) {
            emitStreamEvent({
              workspaceId,
              cardId,
              jobId,
              sequence: lastSequence,
              type: 'error',
              error: state.error,
            })
          }
          emitStreamEvent({
            workspaceId,
            cardId,
            jobId,
            sequence: lastSequence,
            type: 'done',
            sessionId: state.sessionId ?? undefined,
          })
          return { ok: true, resumed: false, jobId }
        }
        void subscribeToJobEvents(workspaceId, cardId, jobId, since)
        return { ok: true, resumed: true, jobId }
      },
      stop: async (workspaceId: string, cardId: string) => {
        const active = activeJobStreams.get(jobStreamKey(workspaceId, cardId))
        stopJobStream(workspaceId, cardId)
        if (!active) return { ok: true }
        await daemonFetch('/chat/job/cancel', {
          method: 'POST',
          body: JSON.stringify({ jobId: active.jobId }),
        }).catch(() => {})
        return { ok: true }
      },
      answerToolPermission: async (args: unknown) =>
        daemonFetch('/chat/job/permission/answer', { method: 'POST', body: JSON.stringify(args) }),
    },

    stream: {
      // The web bridge has one allowed stream shape: daemon job events. It
      // intentionally does not proxy arbitrary renderer-selected URLs.
      start: async () => {
        throw new Error('stream.start is unavailable outside Electron; chat jobs subscribe automatically')
      },
      stop: async (cardId: string) => {
        const matches = [...activeJobStreams.values()]
          .filter(active => active.cardId === cardId)
        // The legacy stream API has no workspace argument. Preserve its
        // single-match behavior without letting an ambiguous card ID stop
        // streams in multiple workspaces.
        if (matches.length === 1) {
          stopJobStream(matches[0]!.workspaceId, cardId)
        }
      },
      onChunk: (callback: (event: Record<string, unknown>) => void) => {
        streamListeners.add(callback)
        return () => streamListeners.delete(callback)
      },
    },

    // MainStatusBar + SettingsPanel require this on every host.
    system: {
      requestMediaAccess: async () => ({ granted: true, status: 'granted' }),
      cleanupTile: async () => ({ ok: true, channelsDropped: 0 }),
      gc: async () => {
        const w = window as unknown as { gc?: () => void }
        if (typeof w.gc === 'function') {
          try { w.gc() } catch { /* ignore */ }
          return { ok: true, exposed: true }
        }
        return { ok: false, exposed: false }
      },
      memStats: async () => {
        // Browser / Native WebView: best-effort via performance.memory (Chrome).
        const perf = performance as Performance & {
          memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number }
        }
        const used = perf.memory?.usedJSHeapSize ?? 0
        const total = perf.memory?.totalJSHeapSize ?? used
        const limit = perf.memory?.jsHeapSizeLimit ?? total
        return {
          rss: total,
          heapTotal: total,
          heapUsed: used,
          heapLimit: limit,
          external: 0,
          arrayBuffers: 0,
          bus: { channels: 0, events: 0, subscriptions: 0, readCursors: 0 },
        }
      },
      daemonStatus: async () => {
        try {
          const health = await hostFetch<{
            daemon?: {
              running?: boolean
              port?: number
              pid?: number
              protocolVersion?: number
            }
          }>('/host/health')
          if (health.daemon?.running) {
            return {
              running: true,
              info: {
                pid: health.daemon.pid ?? 0,
                port: health.daemon.port ?? 0,
                startedAt: new Date().toISOString(),
                protocolVersion: health.daemon.protocolVersion ?? 1,
                appVersion: null,
              },
            }
          }
        } catch {
          // fall through
        }
        return { running: false, info: null }
      },
      daemonSummary: async () => {
        const status = await api.system.daemonStatus()
        try {
          const dashboard = await daemonFetch<{
            jobs?: Array<Record<string, unknown>>
            summary?: {
              total?: number
              active?: number
              backgroundActive?: number
              completed?: number
              failed?: number
              cancelled?: number
              other?: number
            }
            dreaming?: unknown
          }>('/dashboard/api/jobs')
          const summary = dashboard.summary ?? {}
          const jobs = Array.isArray(dashboard.jobs) ? dashboard.jobs : []
          return {
            ...status,
            jobs: {
              total: summary.total ?? jobs.length,
              active: summary.active ?? 0,
              backgroundActive: summary.backgroundActive ?? 0,
              completed: summary.completed ?? 0,
              failed: summary.failed ?? 0,
              cancelled: summary.cancelled ?? 0,
              other: summary.other ?? 0,
              recent: jobs.slice(0, 20).map(job => ({
                id: String(job.id ?? ''),
                taskLabel: (job.taskLabel as string | null) ?? null,
                status: String(job.status ?? ''),
                runMode: (job.runMode as string | null) ?? null,
                workspaceId: (job.workspaceId as string | null) ?? null,
                cardId: (job.cardId as string | null) ?? null,
                provider: (job.provider as string | null) ?? null,
                model: (job.model as string | null) ?? null,
                workspaceDir: (job.workspaceDir as string | null) ?? null,
                sessionId: (job.sessionId as string | null) ?? null,
                initialPrompt: (job.initialPrompt as string | null) ?? null,
                updatedAt: (job.updatedAt as string | null) ?? null,
                requestedAt: (job.requestedAt as string | null) ?? null,
                lastSequence: Number(job.lastSequence ?? 0),
                error: (job.error as string | null) ?? null,
              })),
            },
            dreaming: (dashboard.dreaming as null) ?? null,
          }
        } catch {
          return {
            ...status,
            jobs: {
              total: 0,
              active: 0,
              backgroundActive: 0,
              completed: 0,
              failed: 0,
              cancelled: 0,
              other: 0,
              recent: [],
            },
            dreaming: null,
          }
        }
      },
      restartDaemon: async () => {
        // Soft refresh for web/Native: re-probe host. Hard restart stays Electron/TUI-owned.
        try {
          await hostFetch('/host/health')
        } catch {
          // ignore
        }
        return api.system.daemonStatus()
      },
      onGcRequested: () => noopUnsub(),
    },

    // The gateway owns PTYs/sandboxes. The renderer only speaks the bounded
    // session + WebSocket protocol implemented by TerminalTransport.
    terminal: {
      create: async (
        tileId: string,
        workspaceId: string,
        workspaceDir: string,
        launchBin?: string,
        launchArgs?: string[],
        options?: { cols?: number, rows?: number },
      ) => {
        const session = await terminalTransport.create(tileId, {
          cwd: workspaceDir,
          workspaceId,
          cols: options?.cols,
          rows: options?.rows,
          launchBin,
          launchArgs,
        })
        return { cols: session.cols, rows: session.rows, buffer: session.buffer }
      },
      write: (tileId: string, data: string) => terminalTransport.write(tileId, data),
      cd: (tileId: string, dir: string) => {
        // Hosted sandboxes are POSIX shells. Quote the path rather than adding
        // a privileged server-side `cd` endpoint.
        const escaped = dir.replace(/'/g, "'\\''")
        return terminalTransport.write(tileId, `\x15cd '${escaped}'\r`)
      },
      resize: (tileId: string, cols: number, rows: number) => terminalTransport.resize(tileId, cols, rows),
      destroy: (tileId: string, _workspaceId: string) => terminalTransport.close(tileId),
      dispose: (tileId: string) => terminalTransport.close(tileId),
      detach: (tileId: string) => terminalTransport.close(tileId),
      // Agent-room metadata is an Electron/tmux concern. It never grants a
      // remote terminal new capabilities, so retain the harmless renderer hook.
      updatePeers: async (
        _tileId: string,
        _workspaceId: string,
        _workspaceDir: string,
        _peers: Array<{ peerId: string; peerType: string; tools: string[] }>,
      ) => undefined,
      onData: (tileId: string, callback: (data: string) => void) => terminalTransport.onData(tileId, callback),
      onActive: (tileId: string, callback: () => void) => terminalTransport.onActive(tileId, callback),
      onExit: (tileId: string, callback: (exitCode: number) => void) => terminalTransport.onExit(tileId, callback),
    },
    agents: {
      detect: async () => [],
    },
    mcp: {
      getPort: async () => 0,
      getToken: async () => '',
      getConfig: async () => ({}),
      saveServers: async () => {},
      getWorkspaceServers: async () => ({}),
      saveWorkspaceServers: async () => {},
      getMergedConfig: async () => ({}),
      onKanban: () => noopUnsub(),
      onInject: () => noopUnsub(),
      inject: async () => {},
    },
    extensions: {
      list: async () => [],
      listSidebar: async () => [],
      listTiles: async () => [],
      listChatSurfaces: async () => [],
    },
    // Per-tile protocol dirs under {workspace}/.codesurf/{tileId}/
    // Matches Electron collab IPC so TileChrome mounts without crashing.
    collab: {
      ensureDir: async (workspacePath: string, tileId: string) => {
        await hostFetch('/host/collab/ensureDir', {
          method: 'POST',
          body: JSON.stringify({ workspacePath, tileId }),
        })
        return true
      },
      writeObjective: async (workspacePath: string, tileId: string, md: string) => {
        await hostFetch('/host/collab/write', {
          method: 'POST',
          body: JSON.stringify({ workspacePath, tileId, file: 'objective.md', content: md }),
        })
        return true
      },
      readObjective: async (workspacePath: string, tileId: string) => {
        const res = await hostFetch<{ content: string | null }>('/host/collab/read', {
          method: 'POST',
          body: JSON.stringify({ workspacePath, tileId, file: 'objective.md' }),
        })
        return res.content
      },
      writeSkills: async (workspacePath: string, tileId: string, skills: { enabled: string[]; disabled: string[] }) => {
        await hostFetch('/host/collab/write', {
          method: 'POST',
          body: JSON.stringify({
            workspacePath,
            tileId,
            file: 'skills.json',
            content: JSON.stringify(skills, null, 2),
          }),
        })
        return true
      },
      readSkills: async (workspacePath: string, tileId: string) => {
        const res = await hostFetch<{ content: string | null }>('/host/collab/read', {
          method: 'POST',
          body: JSON.stringify({ workspacePath, tileId, file: 'skills.json' }),
        })
        if (!res.content) return { enabled: [], disabled: [] }
        try {
          return JSON.parse(res.content)
        } catch {
          return { enabled: [], disabled: [] }
        }
      },
      writeState: async (workspacePath: string, tileId: string, state: unknown) => {
        await hostFetch('/host/collab/write', {
          method: 'POST',
          body: JSON.stringify({
            workspacePath,
            tileId,
            file: 'state.json',
            content: JSON.stringify(state, null, 2),
          }),
        })
        return true
      },
      readState: async (workspacePath: string, tileId: string) => {
        const res = await hostFetch<{ content: string | null }>('/host/collab/read', {
          method: 'POST',
          body: JSON.stringify({ workspacePath, tileId, file: 'state.json' }),
        })
        if (!res.content) return null
        try {
          return JSON.parse(res.content)
        } catch {
          return null
        }
      },
      addContext: async (workspacePath: string, tileId: string, filename: string, content: string) => {
        await hostFetch('/host/collab/write', {
          method: 'POST',
          body: JSON.stringify({
            workspacePath,
            tileId,
            file: `context/${filename}`,
            content,
          }),
        })
        return true
      },
      removeContext: async (workspacePath: string, tileId: string, filename: string) => {
        await hostFetch('/host/collab/remove', {
          method: 'POST',
          body: JSON.stringify({ workspacePath, tileId, file: `context/${filename}` }),
        })
        return true
      },
      listContext: async (workspacePath: string, tileId: string) => {
        const res = await hostFetch<{ entries: Array<{ name: string }> }>('/host/collab/list', {
          method: 'POST',
          body: JSON.stringify({ workspacePath, tileId, dir: 'context' }),
        })
        return res.entries ?? []
      },
      readContext: async (workspacePath: string, tileId: string, filename: string) => {
        const res = await hostFetch<{ content: string | null }>('/host/collab/read', {
          method: 'POST',
          body: JSON.stringify({ workspacePath, tileId, file: `context/${filename}` }),
        })
        return res.content
      },
      listMessages: async (workspacePath: string, tileId: string, mailbox: string) => {
        const res = await hostFetch<{ entries: unknown[] }>('/host/collab/list', {
          method: 'POST',
          body: JSON.stringify({ workspacePath, tileId, dir: `messages/${mailbox}` }),
        })
        return res.entries ?? []
      },
      readMessage: async () => null,
      sendMessage: async () => ({ ok: false, error: 'collab sendMessage limited on web host' }),
      updateMessageStatus: async () => true,
      moveMessage: async () => true,
      watchState: async () => true,
      unwatchState: async () => true,
      watchMessages: async () => true,
      unwatchMessages: async () => true,
      removeTileDir: async (workspacePath: string, tileId: string) => {
        await hostFetch('/host/collab/removeDir', {
          method: 'POST',
          body: JSON.stringify({ workspacePath, tileId }),
        }).catch(() => {})
        return true
      },
      pruneOrphanedTileDirs: async () => [],
      onStateChanged: () => noopUnsub(),
      onMessageChanged: () => noopUnsub(),
    },
    activity: {
      upsert: notAvailable('activity.upsert'),
      query: notAvailable('activity.query'),
      byTile: notAvailable('activity.byTile'),
      delete: notAvailable('activity.delete'),
      clearTile: notAvailable('activity.clearTile'),
      byAgent: notAvailable('activity.byAgent'),
      health: async () => ({
        available: false,
        status: 'unavailable' as const,
      }),
    },
    agentPaths: {
      needsSetup: async () => false,
    },
    skills: {
      inspect: notAvailable('skills.inspect'),
      install: notAvailable('skills.install'),
      getDefaultTargetDir: async () => '',
      ready: async () => {},
      onFileOpened: () => noopUnsub(),
    },
    perf: {
      getEnv: () => ({}),
    },
    execution: {
      listHosts: async () => [],
      resolveTarget: async () => null,
    },
    permissions: {
      list: async () => ({ grants: [], version: 1 }),
      clear: async () => ({ grants: [], version: 1 }),
      clearAll: async () => ({ grants: [], version: 1 }),
    },
  }

  // Soft-wrap so any remaining missing preload methods become safe no-ops
  // instead of "X is not a function" error-boundary crashes.
  return softElectronApi(api) as unknown as typeof window.electron
}

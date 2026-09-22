import type { DaemonStatusInfo } from './manager.js'
import type {
  AggregatedSessionEntry,
  DaemonChatJobEvent,
  DaemonChatJobRequest,
  DaemonChatJobState,
  DaemonChatPermissionAnswer,
  DaemonPersonaListResult,
  DaemonAppSettings,
  DaemonSkillEntry,
  DaemonSkillIndex,
  DaemonToolPermissionGrant,
  DaemonToolPermissionListResult,
  DaemonToolPermissionRequest,
  DaemonToolPermissionScope,
  DashboardDreamingSummary,
  DreamRunSummary,
  ExecutionHostRecord,
  ProjectRecord,
  Workspace,
} from './types.js'
import {
  BoundedSseJsonDecoder,
  DaemonChatEventBudget,
  DaemonSseLimitError,
  readBoundedResponseDiagnostic,
  type ParsedSseJsonBuffer,
} from './sse.js'

export interface DaemonClientHooks {
  /**
   * Resolves the live daemon connection (port + token). Typically
   * `manager.ensureDaemonRunning`.
   */
  ensureRunning: (options?: { forceRestart?: boolean }) => Promise<DaemonStatusInfo>
  /**
   * Returns whether the daemon is currently healthy. Used to decide whether to
   * invalidate the cache after a transport failure. Typically
   * `manager.getDaemonStatus`.
   */
  getStatus: () => Promise<{ running: boolean; info: DaemonStatusInfo | null }>
  /** Drops the cached daemon connection so the next request re-discovers it. */
  invalidate: () => void
  /** Optional override for per-request timeout (ms). Defaults to 5000. */
  requestTimeoutMs?: number
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE'
  body?: unknown
  /** Per-request override of the request timeout (ms). */
  timeoutMs?: number
  /** Cancels the request and any read-only retry immediately. */
  signal?: AbortSignal
}

type RequestRetryPolicy = 'read-only' | 'none'

interface InternalRequestOptions extends RequestOptions {
  retryPolicy: RequestRetryPolicy
}

const RETRYABLE_RESPONSE_STATUSES = new Set([401, 408, 502, 503, 504])

class DaemonResponseError extends Error {
  readonly retryable: boolean
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'DaemonResponseError'
    this.status = status
    this.retryable = RETRYABLE_RESPONSE_STATUSES.has(status)
  }
}

class DaemonMutationOutcomeUnknownError extends Error {
  readonly status: number | undefined

  constructor(path: string, cause: Error) {
    super(
      `Daemon mutation outcome is unknown for ${path}: ${cause.message}. Check daemon state before retrying.`,
    )
    this.name = 'DaemonMutationOutcomeUnknownError'
    this.status = cause instanceof DaemonResponseError ? cause.status : undefined
    this.cause = cause
  }
}

export interface StreamJobEventsOptions {
  jobId: string
  since?: number
  signal?: AbortSignal
  /** Maximum reconnects after the initial stream. Defaults to 3, capped at 10. */
  maxReconnectAttempts?: number
  /** Initial reconnect delay in milliseconds. Doubles per retry, capped at 30s. */
  reconnectDelayMs?: number
  onEvent: (event: DaemonChatJobEvent) => void | Promise<void>
  onParseError?: (error: Error) => void | Promise<void>
}

export type DaemonClient = ReturnType<typeof createDaemonClient>

class DaemonStreamConsumerError extends Error {
  readonly original: unknown

  constructor(original: unknown) {
    super(original instanceof Error ? original.message : String(original))
    this.name = 'DaemonStreamConsumerError'
    this.original = original
  }
}

class DaemonStreamSequenceGapError extends Error {
  constructor(jobId: string, expected: number, received: number) {
    super(
      `Daemon event stream sequence gap for job ${jobId}: expected ${expected}, received ${received}`,
    )
    this.name = 'DaemonStreamSequenceGapError'
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal)
}

function awaitAbortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  throwIfAborted(signal)

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => {
      finish(() => reject(abortReason(signal)))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    )
  })
}

async function waitForReconnect(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  if (delayMs <= 0) return

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal ? abortReason(signal) : new DOMException('The operation was aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isActiveJobState(state: DaemonChatJobState | null): boolean {
  return state?.status === 'queued' || state?.status === 'running'
}

/** Idempotency key for a job start; Web Crypto when present, otherwise a random string. */
function makeStartRequestId(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID()
  const part = () => Math.random().toString(36).slice(2)
  return `${Date.now().toString(36)}-${part()}-${part()}`
}

export function createDaemonClient(hooks: DaemonClientHooks) {
  const defaultTimeoutMs = hooks.requestTimeoutMs ?? 5_000

  async function requestWithPolicy<T>(path: string, options: InternalRequestOptions): Promise<T> {
    let lastError: Error | null = null
    const method = options.method ?? (options.body == null ? 'GET' : 'POST')
    const maxAttempts = options.retryPolicy === 'read-only' ? 2 : 1

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      throwIfAborted(options.signal)

      try {
        const daemon = await awaitAbortable(hooks.ensureRunning(), options.signal)
        throwIfAborted(options.signal)
        const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? defaultTimeoutMs)
        const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${daemon.token}`,
            ...(options.body == null ? {} : { 'Content-Type': 'application/json' }),
          },
          body: options.body == null ? undefined : JSON.stringify(options.body),
          signal: options.signal
            ? AbortSignal.any([options.signal, timeoutSignal])
            : timeoutSignal,
        })

        if (!response.ok) {
          const text = await response.text()
          throw new DaemonResponseError(
            text || `Daemon request failed: ${response.status}`,
            response.status,
          )
        }

        return await response.json() as T
      } catch (error) {
        if (options.signal?.aborted) throw abortReason(options.signal)
        lastError = error instanceof Error ? error : new Error(String(error))
        const canRetry = attempt + 1 < maxAttempts

        if (lastError instanceof DaemonResponseError) {
          if (lastError.retryable) {
            hooks.invalidate()
            if (canRetry) continue
          }
          if (method !== 'GET' && lastError.status === 408) {
            throw new DaemonMutationOutcomeUnknownError(path, lastError)
          }
          throw lastError
        }

        const status = await awaitAbortable(
          hooks.getStatus().catch(() => ({ running: false as const, info: null })),
          options.signal,
        )
        if (!status.running) {
          hooks.invalidate()
        }
        if (canRetry) {
          continue
        }

        if (method !== 'GET') {
          throw new DaemonMutationOutcomeUnknownError(path, lastError)
        }
        throw lastError
      }
    }

    throw (lastError ?? new Error('Daemon request failed'))
  }

  async function request<T>(path: string, options?: RequestOptions): Promise<T> {
    const method = options?.method ?? (options?.body == null ? 'GET' : 'POST')
    return await requestWithPolicy<T>(path, {
      ...options,
      retryPolicy: method === 'GET' ? 'read-only' : 'none',
    })
  }

  async function streamJobEvents(options: StreamJobEventsOptions): Promise<void> {
    const jobId = String(options.jobId ?? '').trim()
    if (!jobId) throw new Error('jobId is required')
    const since = Number.isFinite(options.since) ? Number(options.since) : 0
    let lastDeliveredSequence = Math.max(0, since)
    let terminalEventSeen = false
    let terminalCatchupAttempted = false
    let reconnectCount = 0
    const maxReconnectAttempts = Math.min(
      10,
      Math.max(0, Math.trunc(Number(options.maxReconnectAttempts ?? 3) || 0)),
    )
    const reconnectDelayMs = Math.min(
      30_000,
      Math.max(0, Number(options.reconnectDelayMs ?? 250) || 0),
    )
    const eventBudget = new DaemonChatEventBudget({ expectedJobId: jobId })

    async function deliverParsed(
      parsed: ParsedSseJsonBuffer<unknown>,
    ): Promise<{ terminal: boolean }> {
      for (const error of parsed.errors) {
        try {
          await options.onParseError?.(error)
        } catch (consumerError) {
          throw new DaemonStreamConsumerError(consumerError)
        }
      }
      for (const payload of parsed.events) {
        let event: DaemonChatJobEvent
        try {
          event = eventBudget.sanitize(payload)
        } catch (error) {
          if (error instanceof DaemonSseLimitError) throw error
          try {
            await options.onParseError?.(error instanceof Error ? error : new Error(String(error)))
          } catch (consumerError) {
            throw new DaemonStreamConsumerError(consumerError)
          }
          continue
        }
        const sequence = Number(event?.sequence)
        if (sequence <= lastDeliveredSequence) continue
        const expectedSequence = lastDeliveredSequence + 1
        if (sequence !== expectedSequence) {
          throw new DaemonStreamSequenceGapError(jobId, expectedSequence, sequence)
        }
        eventBudget.consume(event)
        try {
          await options.onEvent(event)
        } catch (consumerError) {
          throw new DaemonStreamConsumerError(consumerError)
        }
        lastDeliveredSequence = sequence
        if (event.type === 'done') {
          terminalEventSeen = true
          return { terminal: true }
        }
      }
      return { terminal: false }
    }

    while (true) {
      throwIfAborted(options.signal)
      const isTerminalCatchupAttempt = terminalCatchupAttempted
      let disconnectError: Error | null = null
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null

      try {
        const daemon = await awaitAbortable(hooks.ensureRunning(), options.signal)
        throwIfAborted(options.signal)
        const query = new URLSearchParams({
          jobId,
          since: String(lastDeliveredSequence),
        })
        const response = await fetch(`http://127.0.0.1:${daemon.port}/chat/job/events?${query.toString()}`, {
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${daemon.token}`,
          },
          signal: options.signal,
        })

        if (!response.ok || !response.body) {
          const text = await readBoundedResponseDiagnostic(response).catch(() => '')
          if (RETRYABLE_RESPONSE_STATUSES.has(response.status)) hooks.invalidate()
          throw new DaemonResponseError(
            text || `Daemon event stream failed: ${response.status}`,
            response.status,
          )
        }

        reader = response.body.getReader()
        const decoder = new BoundedSseJsonDecoder<unknown>()

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const delivered = await deliverParsed(decoder.push(value))
          if (delivered.terminal) return
        }

        const delivered = await deliverParsed(decoder.finish())
        if (delivered.terminal) return
      } catch (error) {
        if (error instanceof DaemonStreamConsumerError) {
          if (error.original instanceof Error) throw error.original
          throw new Error(String(error.original))
        }
        if (error instanceof DaemonSseLimitError) throw error
        if (options.signal?.aborted) throw abortReason(options.signal)
        disconnectError = error instanceof Error ? error : new Error(String(error))
      } finally {
        if (reader) {
          try {
            // Cancellation is cleanup, not part of successful delivery or
            // consumer-error settlement. Observe a late rejection without
            // allowing a non-cooperative underlying stream to hang this call.
            void reader.cancel().catch(() => {})
          } catch {}
          try { reader.releaseLock() } catch {}
        }
      }

      if (terminalEventSeen) return
      if (isTerminalCatchupAttempt) {
        if (disconnectError instanceof DaemonStreamSequenceGapError) {
          throw disconnectError
        }
        throw new Error(
          `Daemon terminal replay ended before delivering the terminal event for job ${jobId}`,
          { cause: disconnectError ?? undefined },
        )
      }
      if (disconnectError instanceof DaemonResponseError && !disconnectError.retryable) {
        throw disconnectError
      }

      let state: DaemonChatJobState | null = null
      try {
        state = await request<DaemonChatJobState>(
          `/chat/job/state?jobId=${encodeURIComponent(jobId)}`,
          { signal: options.signal },
        )
      } catch (stateError) {
        if (options.signal?.aborted) throw abortReason(options.signal)
        const daemonStatus = await awaitAbortable(
          hooks.getStatus().catch(() => ({ running: false as const, info: null })),
          options.signal,
        )
        if (!daemonStatus.running) hooks.invalidate()
        if (reconnectCount >= maxReconnectAttempts) {
          throw (disconnectError ?? (stateError instanceof Error ? stateError : new Error(String(stateError))))
        }
      }

      if (state && !isActiveJobState(state)) {
        const terminalLastSequence = Math.max(0, Number(state.lastSequence) || 0)
        if (!terminalCatchupAttempted && terminalLastSequence > lastDeliveredSequence) {
          terminalCatchupAttempted = true
          await waitForReconnect(reconnectDelayMs, options.signal)
          continue
        }
        if (disconnectError instanceof DaemonStreamSequenceGapError) {
          throw disconnectError
        }
        return
      }
      if (reconnectCount >= maxReconnectAttempts) {
        if (state && isActiveJobState(state)) {
          throw new Error(
            `Daemon event stream ended unexpectedly while job ${jobId} remains active`,
            { cause: disconnectError ?? undefined },
          )
        }
        throw (disconnectError ?? new Error(`Daemon event stream ended unexpectedly for job ${jobId}`))
      }

      reconnectCount += 1
      const delay = Math.min(
        30_000,
        reconnectDelayMs * (2 ** (reconnectCount - 1)),
      )
      await waitForReconnect(delay, options.signal)
    }
  }

  return {
    /** Escape hatch for routes the typed surface doesn't cover. */
    request,

    startChatJob(requestBody: DaemonChatJobRequest): Promise<DaemonChatJobState> {
      // D1: a caller that retries a job start after an unknown outcome (lost
      // response, timeout) must reuse the same startRequestId so the daemon
      // coalesces onto the job the first attempt created instead of executing
      // the prompt twice. Generate one when the caller hasn't supplied it.
      const supplied = typeof requestBody.startRequestId === 'string' ? requestBody.startRequestId.trim() : ''
      const startRequestId = supplied || makeStartRequestId()
      return request('/chat/job/start', { body: { request: { ...requestBody, startRequestId } } })
    },
    streamJobEvents,
    getJobState(jobId: string): Promise<DaemonChatJobState> {
      return request(`/chat/job/state?jobId=${encodeURIComponent(jobId)}`)
    },
    cancelJob(jobId: string): Promise<{ ok: boolean; error?: string }> {
      return request('/chat/job/cancel', { body: { jobId } })
    },
    answerPermission(answer: DaemonChatPermissionAnswer): Promise<{ ok: boolean; error?: string }> {
      return request('/chat/job/permission/answer', { body: answer })
    },

    /**
     * READ-ONLY: list Personas (built-ins + the workspace's agents.json overlay)
     * for `codesurf chat --list-personas` and for seeding the soft model binding.
     * The set matches what resolveAuthoritativeAgentMode applies at start time.
     */
    listPersonas(args: { workspaceId?: string | null; workspaceDir?: string | null } = {}): Promise<DaemonPersonaListResult> {
      const query = new URLSearchParams()
      const workspaceId = String(args.workspaceId ?? '').trim()
      const workspaceDir = String(args.workspaceDir ?? '').trim()
      if (workspaceId) query.set('workspaceId', workspaceId)
      if (workspaceDir) query.set('workspaceDir', workspaceDir)
      return request(`/personas/list${query.size > 0 ? `?${query.toString()}` : ''}`)
    },

    getJobDashboard(): Promise<{
      jobs: Array<{
        id: string
        taskLabel: string | null
        status: string
        runMode?: string | null
        workspaceId?: string | null
        cardId?: string | null
        provider: string | null
        model: string | null
        workspaceDir: string | null
        requestedAt: string | null
        updatedAt: string | null
        completedAt?: string | null
        lastSequence: number
        sessionId?: string | null
        initialPrompt?: string | null
        error: string | null
      }>
      summary: {
        total: number
        active: number
        backgroundActive: number
        completed: number
        failed: number
        cancelled: number
        other: number
      }
      daemon: {
        pid: number
        startedAt: string
        appVersion: string | null
      }
      dreaming?: DashboardDreamingSummary | null
    }> {
      return request('/dashboard/api/jobs')
    },

    listHosts(): Promise<ExecutionHostRecord[]> {
      return request('/host/list')
    },
    upsertHost(host: ExecutionHostRecord): Promise<ExecutionHostRecord[]> {
      return request('/host/upsert', { body: { host } })
    },
    deleteHost(id: string): Promise<{ ok: true; hosts: ExecutionHostRecord[] }> {
      return request(`/host/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },

    listPermissions(): Promise<DaemonToolPermissionListResult> {
      return request('/permissions')
    },
    setPermissionGrant(args: DaemonToolPermissionRequest & {
      action?: 'allow' | 'deny'
      scope?: Exclude<DaemonToolPermissionScope, 'session'> | null
    }): Promise<DaemonToolPermissionListResult & { grant: DaemonToolPermissionGrant }> {
      return request('/permissions/grant', { body: args })
    },
    resolvePermission(args: DaemonToolPermissionRequest): Promise<{
      decision: 'allow' | 'deny' | null
      grant: DaemonToolPermissionGrant | null
    }> {
      return request('/permissions/resolve', { body: args })
    },
    clearPermissionGrant(id: string): Promise<DaemonToolPermissionListResult> {
      return request('/permissions/clear', { body: { id } })
    },
    clearAllPermissionGrants(): Promise<DaemonToolPermissionListResult> {
      return request('/permissions/clear', { body: { all: true } })
    },

    listWorkspaces(): Promise<Workspace[]> {
      return request('/workspace/list')
    },
    listProjects(): Promise<ProjectRecord[]> {
      return request('/workspace/projects')
    },
    getActiveWorkspace(): Promise<Workspace | null> {
      return request('/workspace/active')
    },
    createWorkspace(name: string): Promise<Workspace> {
      return request('/workspace/create', { body: { name } })
    },
    createWorkspaceWithPath(name: string, projectPath: string): Promise<Workspace> {
      return request('/workspace/create-with-path', { body: { name, projectPath } })
    },
    createWorkspaceFromFolder(folderPath: string): Promise<Workspace> {
      return request('/workspace/create-from-folder', { body: { folderPath } })
    },
    addProjectFolder(workspaceId: string, folderPath: string): Promise<Workspace | null> {
      return request('/workspace/add-project-folder', { body: { workspaceId, folderPath } })
    },
    removeProjectFolder(workspaceId: string, folderPath: string): Promise<Workspace | null> {
      return request('/workspace/remove-project-folder', { body: { workspaceId, folderPath } })
    },
    renameProject(args: { projectId?: string; projectPath?: string; name: string }): Promise<{ ok: boolean; error?: string; project?: ProjectRecord }> {
      return request('/workspace/project/rename', { body: args })
    },
    createProjectWorktree(args: { projectId?: string; projectPath?: string; name: string; branch?: string }): Promise<{ ok: boolean; error?: string; project?: ProjectRecord; path?: string; branch?: string }> {
      return request('/workspace/project/worktree', { body: args })
    },
    setActiveWorkspace(id: string): Promise<{ ok: true }> {
      return request('/workspace/set-active', { body: { id } })
    },
    deleteWorkspace(id: string): Promise<{ ok: true }> {
      return request(`/workspace/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },

    listLocalSessions(workspaceId: string): Promise<AggregatedSessionEntry[]> {
      return request(`/session/local/list?workspaceId=${encodeURIComponent(workspaceId)}`)
    },
    upsertRuntimeSession(workspaceId: string, cardId: string, state: unknown): Promise<{ ok: boolean; summary?: unknown; error?: string }> {
      return request('/session/runtime/upsert', { body: { workspaceId, cardId, state } })
    },
    clearRuntimeSession(workspaceId: string, cardId: string): Promise<{ ok: boolean; error?: string }> {
      return request('/session/runtime/clear', { body: { workspaceId, cardId } })
    },
    getLocalSessionState(workspaceId: string, sessionEntryId: string): Promise<unknown | null> {
      return request(`/session/local/state?workspaceId=${encodeURIComponent(workspaceId)}&sessionEntryId=${encodeURIComponent(sessionEntryId)}`)
    },
    deleteLocalSession(workspaceId: string, sessionEntryId: string): Promise<{ ok: boolean; error?: string }> {
      return request('/session/local/delete', { body: { workspaceId, sessionEntryId } })
    },
    renameLocalSession(workspaceId: string, sessionEntryId: string, title: string): Promise<{ ok: boolean; error?: string; title?: string }> {
      return request('/session/local/rename', { body: { workspaceId, sessionEntryId, title } })
    },

    listExternalSessions(workspacePath: string | null, force = false): Promise<AggregatedSessionEntry[]> {
      const normalizedPath = String(workspacePath ?? '').trim()
      const query = new URLSearchParams()
      if (normalizedPath) query.set('workspacePath', normalizedPath)
      if (force) query.set('force', '1')
      return request(`/session/external/list?${query.toString()}`)
    },
    invalidateExternalSessions(workspacePath: string | null): Promise<{ ok: boolean }> {
      return request('/session/external/invalidate', {
        body: { workspacePath: String(workspacePath ?? '').trim() || null },
      })
    },
    getExternalSessionState(workspacePath: string | null, sessionEntryId: string): Promise<unknown | null> {
      const normalizedPath = String(workspacePath ?? '').trim()
      const query = new URLSearchParams()
      if (normalizedPath) query.set('workspacePath', normalizedPath)
      query.set('sessionEntryId', sessionEntryId)
      return request(`/session/external/state?${query.toString()}`)
    },
    deleteExternalSession(workspacePath: string | null, sessionEntryId: string): Promise<{ ok: boolean; error?: string }> {
      return request('/session/external/delete', {
        body: {
          workspacePath: String(workspacePath ?? '').trim() || null,
          sessionEntryId,
        },
      })
    },
    renameExternalSession(workspacePath: string | null, sessionEntryId: string, title: string): Promise<{ ok: boolean; error?: string; title?: string }> {
      return request('/session/external/rename', {
        body: {
          workspacePath: String(workspacePath ?? '').trim() || null,
          sessionEntryId,
          title,
        },
      })
    },

    createCheckpoint(workspaceId: string, sessionEntryId: string, payload: {
      label?: string | null
      reason?: string | null
      files?: string[]
      metadata?: Record<string, unknown>
      source?: string | null
    }): Promise<{ ok: boolean; checkpoint?: { id: string }; error?: string }> {
      return request('/checkpoint/create', { body: { workspaceId, sessionEntryId, ...payload } })
    },
    listCheckpoints(workspaceId: string, sessionEntryId: string): Promise<Array<{
      id: string
      sessionEntryId: string
      createdAt: string
      restoredAt?: string | null
      label: string
      reason?: string | null
      fileCount: number
      files: string[]
    }>> {
      return request('/checkpoint/list', { body: { workspaceId, sessionEntryId } })
    },
    restoreCheckpoint(workspaceId: string, checkpointId: string, sessionEntryId?: string | null): Promise<{
      ok: boolean
      checkpoint?: { id: string }
      filesRestored?: number
      filesDeleted?: number
      error?: string
    }> {
      return request('/checkpoint/restore', {
        body: { workspaceId, checkpointId, sessionEntryId: sessionEntryId ?? null },
      })
    },

    loadMemoryContext(workspaceId: string, executionTarget: 'local' | 'cloud' = 'local'): Promise<{
      executionTarget: 'local' | 'cloud'
      includedBuckets: string[]
      sections: Array<{
        scope: string
        bucket: string
        displayPath: string
        path: string
        importedFrom?: string | null
        content: string
      }>
      prompt?: string
      contextBuckets?: {
        version: number
        includedBuckets: string[]
        buckets: Array<{
          bucket: string
          included: boolean
          sectionCount: number
          sections: Array<{
            scope: string
            displayPath: string
            importedFrom?: string | null
          }>
        }>
        inspect?: {
          summary?: string
          input?: string
        }
      }
    }> {
      return request(`/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=${encodeURIComponent(executionTarget)}`)
    },

    getDreamStatus(workspaceId: string): Promise<{
      workspaceId: string
      running: boolean
      activeRun: DreamRunSummary | null
      lastRun: DreamRunSummary | null
      state: {
        workspaceId: string
        lastRunId: string | null
        lastCompletedAt: string | null
        lastSuccessfulRunId: string | null
        lastSuccessfulCompletedAt: string | null
        lastReviewedAt: string | null
        latestMemoryPath: string | null
      }
    }> {
      return request(`/dreaming/status?workspaceId=${encodeURIComponent(workspaceId)}`)
    },
    listDreamRuns(workspaceId: string, limit = 20): Promise<{ workspaceId: string; runs: DreamRunSummary[] }> {
      return request(`/dreaming/runs?workspaceId=${encodeURIComponent(workspaceId)}&limit=${encodeURIComponent(String(limit))}`)
    },
    runDream(args: { workspaceId: string; provider?: string; model?: string; maxSessions?: number }): Promise<{ started: boolean; run: DreamRunSummary }> {
      return request('/dreaming/run', { body: args })
    },
    cancelDream(args: { workspaceId: string; runId?: string | null }): Promise<{ ok: boolean; error?: string }> {
      return request('/dreaming/cancel', { body: args })
    },

    listSkills(args: { workspaceId?: string | null; workspaceDir?: string | null; cardId?: string | null } = {}): Promise<DaemonSkillIndex> {
      const query = new URLSearchParams()
      const workspaceId = String(args.workspaceId ?? '').trim()
      const workspaceDir = String(args.workspaceDir ?? '').trim()
      const cardId = String(args.cardId ?? '').trim()
      if (workspaceId) query.set('workspaceId', workspaceId)
      if (workspaceDir) query.set('workspaceDir', workspaceDir)
      if (cardId) query.set('cardId', cardId)
      return request(`/skills/list${query.size > 0 ? `?${query.toString()}` : ''}`)
    },
    getSkill(args: { skillId: string; workspaceId?: string | null; workspaceDir?: string | null; cardId?: string | null }): Promise<DaemonSkillEntry | null> {
      const query = new URLSearchParams()
      query.set('skillId', String(args.skillId ?? '').trim())
      const workspaceId = String(args.workspaceId ?? '').trim()
      const workspaceDir = String(args.workspaceDir ?? '').trim()
      const cardId = String(args.cardId ?? '').trim()
      if (workspaceId) query.set('workspaceId', workspaceId)
      if (workspaceDir) query.set('workspaceDir', workspaceDir)
      if (cardId) query.set('cardId', cardId)
      return request(`/skills/get?${query.toString()}`)
    },
    installSkill(args: {
      zipPath: string
      scope?: 'global' | 'workspace'
      overwrite?: boolean
      workspaceId?: string | null
      workspaceDir?: string | null
      cardId?: string | null
    }): Promise<{ ok: boolean; scope: 'global' | 'workspace'; targetRoot: string; installedPath: string; skill: DaemonSkillEntry }> {
      return request('/skills/install', { body: args })
    },

    expandFileReferences(payload: {
      message: string
      workspaceId?: string | null
      cardId?: string | null
      workspaceDir?: string | null
      executionTarget?: 'local' | 'cloud'
      supportedImageMediaTypes?: string[]
    }): Promise<{
      changed: boolean
      message: string
      bodyText: string
      contextText?: string
      references: Array<{
        source: string
        displayPath: string
        byteCount: number
        truncated: boolean
        binary?: boolean
        mediaType?: string
        resolvedPath?: string
        device?: string
        inode?: string
        mtimeMs?: number
        ctimeMs?: number
        ownedTemporary?: boolean
      }>
      ownedTemporaryAttachments?: Array<{
        capability: string
        path: string
        mediaType?: string
        displayPath: string
        byteCount: number
        device: string
        inode: string
        mtimeMs: number
        ctimeMs: number
        ownedTemporary: true
      }>
      summaryText?: string
      inputText?: string
    }> {
      return request('/file-references/expand', {
        body: {
          message: payload.message,
          workspaceId: String(payload.workspaceId ?? '').trim() || null,
          cardId: String(payload.cardId ?? '').trim() || null,
          workspaceDir: String(payload.workspaceDir ?? '').trim() || null,
          executionTarget: payload.executionTarget === 'cloud' ? 'cloud' : 'local',
          supportedImageMediaTypes: payload.supportedImageMediaTypes,
        },
      })
    },

    issueAttachmentCapabilities(payload: {
      workspaceId: string
      cardId: string
      paths: string[]
      ownedTemporary?: boolean
    }): Promise<{ attachments: Array<{ capability: string; displayName: string }> }> {
      return request('/file-references/capabilities/issue', { body: payload })
    },

    inspectAttachmentCapabilities(payload: {
      workspaceId: string
      cardId: string
      capabilities: string[]
    }): Promise<{ hasAttachments: boolean }> {
      return request('/file-references/capabilities/inspect', { body: payload })
    },

    getSettings<T = DaemonAppSettings>(): Promise<T> {
      return request<T>('/settings')
    },
    setSettings<T = DaemonAppSettings>(settings: T): Promise<T> {
      return request<T>('/settings', { body: { settings } })
    },
    getRawSettingsJson(): Promise<{ path: string; content: string }> {
      return request('/settings/raw')
    },
    setRawSettingsJson<T = DaemonAppSettings>(json: string): Promise<{ ok: boolean; error?: string; settings?: T }> {
      return request('/settings/raw', { body: { json } })
    },
  }
}

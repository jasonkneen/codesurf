import type { AppSettings, ExecutionHostRecord, ProjectRecord, Workspace } from '../../shared/types'
import type { AggregatedSessionEntry } from '../../shared/session-types'
import { ensureDaemonRunning, getDaemonStatus, invalidateDaemonCache } from './manager'

type RequestOptions = {
  method?: 'GET' | 'POST' | 'DELETE'
  body?: unknown
}

async function daemonRequest<T>(path: string, options?: RequestOptions): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const daemon = await ensureDaemonRunning()

    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
        method: options?.method ?? (options?.body == null ? 'GET' : 'POST'),
        headers: {
          Authorization: `Bearer ${daemon.token}`,
          ...(options?.body == null ? {} : { 'Content-Type': 'application/json' }),
        },
        body: options?.body == null ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(5_000),
      })

      if (!response.ok) {
        const text = await response.text()
        const error = new Error(text || `Daemon request failed: ${response.status}`)
        lastError = error
        if (attempt === 0 && (response.status === 401 || response.status === 408 || response.status === 502 || response.status === 503 || response.status === 504)) {
          invalidateDaemonCache()
          continue
        }
        throw error
      }

      return await response.json() as T
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt === 0) {
        const daemonStatus = await getDaemonStatus().catch(() => ({ running: false as const, info: null }))
        if (!daemonStatus.running) {
          invalidateDaemonCache()
        }
        continue
      }
      throw lastError
    }
  }

  throw (lastError ?? new Error('Daemon request failed'))
}

export const daemonClient = {
  getJobDashboard(): Promise<{
    jobs: Array<{
      id: string
      taskLabel: string | null
      status: string
      runMode?: string | null
      provider: string | null
      model: string | null
      workspaceDir: string | null
      requestedAt: string | null
      updatedAt: string | null
      completedAt?: string | null
      lastSequence: number
      sessionId?: string | null
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
  }> {
    return daemonRequest('/dashboard/api/jobs')
  },
  listHosts(): Promise<ExecutionHostRecord[]> {
    return daemonRequest('/host/list')
  },
  upsertHost(host: ExecutionHostRecord): Promise<ExecutionHostRecord[]> {
    return daemonRequest('/host/upsert', { body: { host } })
  },
  deleteHost(id: string): Promise<{ ok: true; hosts: ExecutionHostRecord[] }> {
    return daemonRequest(`/host/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  listWorkspaces(): Promise<Workspace[]> {
    return daemonRequest('/workspace/list')
  },
  listProjects(): Promise<ProjectRecord[]> {
    return daemonRequest('/workspace/projects')
  },
  getActiveWorkspace(): Promise<Workspace | null> {
    return daemonRequest('/workspace/active')
  },
  createWorkspace(name: string): Promise<Workspace> {
    return daemonRequest('/workspace/create', { body: { name } })
  },
  createWorkspaceWithPath(name: string, projectPath: string): Promise<Workspace> {
    return daemonRequest('/workspace/create-with-path', { body: { name, projectPath } })
  },
  createWorkspaceFromFolder(folderPath: string): Promise<Workspace> {
    return daemonRequest('/workspace/create-from-folder', { body: { folderPath } })
  },
  addProjectFolder(workspaceId: string, folderPath: string): Promise<Workspace | null> {
    return daemonRequest('/workspace/add-project-folder', { body: { workspaceId, folderPath } })
  },
  removeProjectFolder(workspaceId: string, folderPath: string): Promise<Workspace | null> {
    return daemonRequest('/workspace/remove-project-folder', { body: { workspaceId, folderPath } })
  },
  setActiveWorkspace(id: string): Promise<{ ok: true }> {
    return daemonRequest('/workspace/set-active', { body: { id } })
  },
  deleteWorkspace(id: string): Promise<{ ok: true }> {
    return daemonRequest(`/workspace/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  listLocalSessions(workspaceId: string): Promise<AggregatedSessionEntry[]> {
    return daemonRequest(`/session/local/list?workspaceId=${encodeURIComponent(workspaceId)}`)
  },
  listExternalSessions(workspacePath: string | null, force = false): Promise<AggregatedSessionEntry[]> {
    const normalizedPath = String(workspacePath ?? '').trim()
    const query = new URLSearchParams()
    if (normalizedPath) query.set('workspacePath', normalizedPath)
    if (force) query.set('force', '1')
    return daemonRequest(`/session/external/list?${query.toString()}`)
  },
  invalidateExternalSessions(workspacePath: string | null): Promise<{ ok: boolean }> {
    return daemonRequest('/session/external/invalidate', {
      body: { workspacePath: String(workspacePath ?? '').trim() || null },
    })
  },
  getExternalSessionState(workspacePath: string | null, sessionEntryId: string): Promise<unknown | null> {
    const normalizedPath = String(workspacePath ?? '').trim()
    const query = new URLSearchParams()
    if (normalizedPath) query.set('workspacePath', normalizedPath)
    query.set('sessionEntryId', sessionEntryId)
    return daemonRequest(`/session/external/state?${query.toString()}`)
  },
  deleteExternalSession(workspacePath: string | null, sessionEntryId: string): Promise<{ ok: boolean; error?: string }> {
    return daemonRequest('/session/external/delete', {
      body: {
        workspacePath: String(workspacePath ?? '').trim() || null,
        sessionEntryId,
      },
    })
  },
  renameExternalSession(workspacePath: string | null, sessionEntryId: string, title: string): Promise<{ ok: boolean; error?: string; title?: string }> {
    return daemonRequest('/session/external/rename', {
      body: {
        workspacePath: String(workspacePath ?? '').trim() || null,
        sessionEntryId,
        title,
      },
    })
  },
  getLocalSessionState(workspaceId: string, sessionEntryId: string): Promise<unknown | null> {
    return daemonRequest(`/session/local/state?workspaceId=${encodeURIComponent(workspaceId)}&sessionEntryId=${encodeURIComponent(sessionEntryId)}`)
  },
  deleteLocalSession(workspaceId: string, sessionEntryId: string): Promise<{ ok: boolean; error?: string }> {
    return daemonRequest('/session/local/delete', { body: { workspaceId, sessionEntryId } })
  },
  renameLocalSession(workspaceId: string, sessionEntryId: string, title: string): Promise<{ ok: boolean; error?: string; title?: string }> {
    return daemonRequest('/session/local/rename', { body: { workspaceId, sessionEntryId, title } })
  },
  getSettings(): Promise<AppSettings> {
    return daemonRequest('/settings')
  },
  setSettings(settings: AppSettings): Promise<AppSettings> {
    return daemonRequest('/settings', { body: { settings } })
  },
  getRawSettingsJson(): Promise<{ path: string; content: string }> {
    return daemonRequest('/settings/raw')
  },
  setRawSettingsJson(json: string): Promise<{ ok: boolean; error?: string; settings?: AppSettings }> {
    return daemonRequest('/settings/raw', { body: { json } })
  },
}

import { ipcMain, BrowserWindow } from 'electron'
import { getHeapStatistics } from 'v8'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { bus } from '../event-bus'
import { removeTile as removePeerTile } from '../peer-state'
import { getDaemonStatus, restartDaemon } from '../daemon/manager'
import { daemonClient } from '../daemon/client'
import { CONTEX_HOME } from '../paths'
import { getDb, getDbStatus, resetDatabase } from '../db'

// Debounce GC — if cleanupTile is called many times in quick succession we don't
// want to hammer global.gc(). Runs ~1s after the last cleanup.
let gcTimer: NodeJS.Timeout | null = null

function scheduleGC(): void {
  if (gcTimer) clearTimeout(gcTimer)
  gcTimer = setTimeout(() => {
    gcTimer = null
    runGC()
  }, 1000)
}

function runGC(): void {
  // Main process — requires electron launched with --js-flags=--expose-gc
  const g = globalThis as unknown as { gc?: () => void }
  if (typeof g.gc === 'function') {
    try {
      g.gc()
    } catch (err) {
      console.warn('[system] main gc() threw:', err)
    }
  }
  // Renderers — request they run gc too (window.gc requires --expose-gc on renderer)
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    try {
      win.webContents.send('system:gc-requested')
    } catch { /* sender dead */ }
  }
}

function sanitizeDaemonState(result: { running: boolean; info: Awaited<ReturnType<typeof getDaemonStatus>>['info'] }): {
  running: boolean
  info: {
    pid: number
    port: number
    startedAt: string
    protocolVersion: number
    appVersion: string | null
  } | null
} {
  if (!result.info) {
    return { running: result.running, info: null }
  }

  return {
    running: result.running,
    info: {
      pid: result.info.pid,
      port: result.info.port,
      startedAt: result.info.startedAt,
      protocolVersion: result.info.protocolVersion,
      appVersion: result.info.appVersion,
    },
  }
}

type DaemonJobRecord = {
  id: string
  taskLabel?: string | null
  status: string
  runMode?: string | null
  workspaceId?: string | null
  cardId?: string | null
  provider?: string
  model?: string
  workspaceDir?: string | null
  sessionId?: string | null
  initialPrompt?: string | null
  requestedAt?: string
  updatedAt?: string
  completedAt?: string | null
  lastSequence?: number
  error?: string | null
}

function readDaemonJobSummary(): {
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
} {
  const jobsDir = join(CONTEX_HOME, 'jobs')
  if (!existsSync(jobsDir)) {
    return {
      total: 0,
      active: 0,
      backgroundActive: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      other: 0,
      recent: [],
    }
  }

  const records: DaemonJobRecord[] = []
  for (const entry of readdirSync(jobsDir)) {
    if (!entry.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(jobsDir, entry), 'utf8')) as DaemonJobRecord
      if (parsed && typeof parsed.id === 'string') records.push(parsed)
    } catch {
      // ignore corrupt metadata files
    }
  }

  const normalized = records
    .map(record => ({
      id: record.id,
      taskLabel: typeof record.taskLabel === 'string' ? record.taskLabel : null,
      status: typeof record.status === 'string' ? record.status : 'unknown',
      runMode: typeof record.runMode === 'string' ? record.runMode : 'foreground',
      workspaceId: typeof record.workspaceId === 'string' ? record.workspaceId : null,
      cardId: typeof record.cardId === 'string' ? record.cardId : null,
      provider: typeof record.provider === 'string' ? record.provider : null,
      model: typeof record.model === 'string' ? record.model : null,
      workspaceDir: typeof record.workspaceDir === 'string' ? record.workspaceDir : null,
      sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
      initialPrompt: typeof record.initialPrompt === 'string' ? record.initialPrompt : null,
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
      requestedAt: typeof record.requestedAt === 'string' ? record.requestedAt : null,
      lastSequence: typeof record.lastSequence === 'number' ? record.lastSequence : 0,
      error: typeof record.error === 'string' ? record.error : null,
    }))
    .sort((a, b) => {
      const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0
      const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0
      return bTime - aTime
    })

  const counts = normalized.reduce((acc, record) => {
    if (record.status === 'running' || record.status === 'starting' || record.status === 'queued' || record.status === 'reconnecting') {
      acc.active += 1
      if (record.runMode === 'background') acc.backgroundActive += 1
    } else if (record.status === 'completed') {
      acc.completed += 1
    } else if (record.status === 'failed' || record.status === 'lost') {
      acc.failed += 1
    } else if (record.status === 'cancelled') {
      acc.cancelled += 1
    } else {
      acc.other += 1
    }
    return acc
  }, {
    active: 0,
    backgroundActive: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    other: 0,
  })

  return {
    total: normalized.length,
    active: counts.active,
    backgroundActive: counts.backgroundActive,
    completed: counts.completed,
    failed: counts.failed,
    cancelled: counts.cancelled,
    other: counts.other,
    recent: normalized.slice(0, 20),
  }
}

export function registerSystemIPC(): void {
  // Local SQLite diagnostics / reset (phase 0 harness; no feature code yet uses the DB).
  ipcMain.handle('db:status', () => {
    try { return { ok: true, status: getDbStatus() } }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })
  ipcMain.handle('db:reset', () => {
    try {
      const { backupPath } = resetDatabase()
      // Reopen immediately so the next feature call doesn't race.
      getDb()
      return { ok: true, backupPath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('system:cleanupTile', (_, tileId: string) => {
    if (!tileId || typeof tileId !== 'string') return { ok: false }
    // 1. Drop all bus history pinned to this tile
    const channelsDropped = bus.dropChannelsMatching(`tile:${tileId}`)
    // 2. Clear peer state (agent state, messages, links)
    removePeerTile(tileId)
    // 3. Schedule a debounced GC
    scheduleGC()
    return { ok: true, channelsDropped }
  })

  ipcMain.handle('system:gc', () => {
    runGC()
    return { ok: true, exposed: typeof (globalThis as { gc?: unknown }).gc === 'function' }
  })

  ipcMain.handle('system:memStats', () => {
    const mem = process.memoryUsage()
    const heap = getHeapStatistics()
    return {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      heapLimit: heap.heap_size_limit,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      bus: bus.getStats(),
    }
  })

  ipcMain.handle('system:daemonStatus', async () => {
    return sanitizeDaemonState(await getDaemonStatus())
  })

  ipcMain.handle('system:daemonSummary', async () => {
    const status = sanitizeDaemonState(await getDaemonStatus())
    const dashboard = await daemonClient.getJobDashboard().catch(() => null)
    if (dashboard) {
      return {
        ...status,
        jobs: {
          total: dashboard.summary.total,
          active: dashboard.summary.active,
          backgroundActive: dashboard.summary.backgroundActive,
          completed: dashboard.summary.completed,
          failed: dashboard.summary.failed,
          cancelled: dashboard.summary.cancelled,
          other: dashboard.summary.other,
          recent: dashboard.jobs.slice(0, 6).map(job => ({
            id: job.id,
            taskLabel: job.taskLabel,
            status: job.status,
            runMode: job.runMode ?? null,
            workspaceId: job.workspaceId ?? null,
            cardId: job.cardId ?? null,
            provider: job.provider,
            model: job.model,
            workspaceDir: job.workspaceDir,
            sessionId: job.sessionId ?? null,
            initialPrompt: job.initialPrompt ?? null,
            updatedAt: job.updatedAt,
            requestedAt: job.requestedAt,
            lastSequence: job.lastSequence,
            error: job.error,
          })).slice(0, 20),
        },
      }
    }
    return {
      ...status,
      jobs: readDaemonJobSummary(),
    }
  })

  ipcMain.handle('system:restartDaemon', async () => {
    const info = await restartDaemon()
    return sanitizeDaemonState({ running: true, info })
  })
}

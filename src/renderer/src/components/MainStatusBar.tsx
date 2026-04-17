import React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Cpu, Activity } from 'lucide-react'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'
import { Tooltip } from './Tooltip'

type MemoryStats = {
  rss: number
  heapTotal: number
  heapUsed: number
  heapLimit: number
  external: number
  arrayBuffers: number
  bus: { channels: number; events: number; subscriptions: number; readCursors: number }
}

type DaemonStatus = {
  running: boolean
  info: {
    pid: number
    port: number
    startedAt: string
    protocolVersion: number
    appVersion: string | null
  } | null
}

type DaemonSummary = DaemonStatus & {
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
}

type DaemonTaskRow = DaemonSummary['jobs']['recent'][number] & {
  runCount: number
}

const REFRESH_MS = 1500
const DAEMON_REFRESH_MS = 5000

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const precision = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(precision)} ${units[unitIndex]}`
}

function formatRelativeTime(value: string | null): string {
  if (!value) return 'Unknown'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (diffSeconds < 5) return 'just now'
  if (diffSeconds < 60) return `${diffSeconds}s ago`
  const minutes = Math.floor(diffSeconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function statusTone(theme: ReturnType<typeof useTheme>, status: string): string {
  if (status === 'running' || status === 'starting' || status === 'queued' || status === 'reconnecting') return theme.status.success
  if (status === 'completed') return theme.text.secondary
  if (status === 'cancelled') return theme.status.warning
  if (status === 'failed' || status === 'lost') return theme.status.danger
  return theme.text.disabled
}

function jobGroupKey(job: DaemonSummary['jobs']['recent'][number]): string {
  const sessionKey = String(job.sessionId ?? '').trim()
  if (sessionKey) return `session:${sessionKey}`

  const taskLabel = String(job.taskLabel ?? job.initialPrompt ?? '').trim().toLowerCase()
  const provider = String(job.provider ?? '').trim().toLowerCase()
  const model = String(job.model ?? '').trim().toLowerCase()
  const workspaceDir = String(job.workspaceDir ?? '').trim().toLowerCase()
  return `task:${taskLabel}::${provider}::${model}::${workspaceDir}`
}

function summarizeDaemonTaskRows(items: DaemonSummary['jobs']['recent']): DaemonTaskRow[] {
  const grouped = new Map<string, DaemonTaskRow>()

  for (const job of items) {
    const key = jobGroupKey(job)
    const existing = grouped.get(key)
    if (!existing) {
      grouped.set(key, { ...job, runCount: 1 })
      continue
    }

    existing.runCount += 1
    const existingTime = Date.parse(existing.updatedAt ?? existing.requestedAt ?? '') || 0
    const nextTime = Date.parse(job.updatedAt ?? job.requestedAt ?? '') || 0
    if (nextTime > existingTime) {
      grouped.set(key, { ...job, runCount: existing.runCount })
    }
  }

  return [...grouped.values()].sort((a, b) => {
    const aActive = a.status === 'running' || a.status === 'starting' || a.status === 'queued' || a.status === 'reconnecting' ? 1 : 0
    const bActive = b.status === 'running' || b.status === 'starting' || b.status === 'queued' || b.status === 'reconnecting' ? 1 : 0
    if (aActive !== bActive) return bActive - aActive
    const aTime = Date.parse(a.updatedAt ?? a.requestedAt ?? '') || 0
    const bTime = Date.parse(b.updatedAt ?? b.requestedAt ?? '') || 0
    return bTime - aTime
  })
}

interface MainStatusBarProps {
  onOpenDaemonTask?: (task: DaemonSummary['jobs']['recent'][number]) => void
  /** 'compact' (default) shows a dot + HEALTH label with hover detail.
   *  'verbose' renders the full heap bar + numbers inline. */
  health?: 'compact' | 'verbose'
}

export function MainStatusBar({ onOpenDaemonTask, health = 'compact' }: MainStatusBarProps): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null)
  const [daemonSummary, setDaemonSummary] = useState<DaemonSummary | null>(null)
  const [showDaemonSummary, setShowDaemonSummary] = useState(false)
  const daemonRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false

    const load = () => {
      window.electron.system.memStats().then(next => {
        if (!cancelled) setStats(next)
      }).catch(() => {})
    }

    load()
    const interval = window.setInterval(load, REFRESH_MS)
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const load = () => {
      window.electron.system.daemonStatus().then(next => {
        if (!cancelled) setDaemon(next)
      }).catch(() => {
        if (!cancelled) setDaemon({ running: false, info: null })
      })
    }

    load()
    const interval = window.setInterval(load, DAEMON_REFRESH_MS)
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const load = () => {
      window.electron.system.daemonSummary().then(next => {
        if (!cancelled) setDaemonSummary(next)
      }).catch(() => {
        if (!cancelled) setDaemonSummary(null)
      })
    }

    load()
    const interval = window.setInterval(load, DAEMON_REFRESH_MS)
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => {
    if (!showDaemonSummary) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!daemonRef.current?.contains(event.target as Node)) {
        setShowDaemonSummary(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowDaemonSummary(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [showDaemonSummary])

  const usage = useMemo(() => {
    const heapLimit = stats?.heapLimit && stats.heapLimit > 0 ? stats.heapLimit : stats?.heapTotal ?? 0
    const heapUsed = stats?.heapUsed ?? 0
    const heapTotal = stats?.heapTotal ?? 0
    const ratio = heapLimit > 0 ? Math.min(1, heapUsed / heapLimit) : 0
    const committedRatio = heapLimit > 0 ? Math.min(1, heapTotal / heapLimit) : 0
    return { heapLimit, heapUsed, heapTotal, ratio, committedRatio }
  }, [stats])

  const fillColor = usage.ratio >= 0.85
    ? theme.status.danger
    : usage.ratio >= 0.7
      ? theme.status.warning
      : theme.accent.base

  const barBackground = theme.mode === 'light' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)'
  const title = stats
    ? `Main heap ${formatBytes(usage.heapUsed)} / ${formatBytes(usage.heapLimit || usage.heapTotal)} - RSS ${formatBytes(stats.rss)} - external ${formatBytes(stats.external)}`
    : 'Loading memory stats'
  const daemonColor = daemon == null
    ? theme.text.disabled
    : daemon.running
      ? theme.text.secondary
      : theme.status.danger
  const daemonDot = daemon == null
    ? theme.text.disabled
    : daemon.running
      ? theme.status.success
      : theme.status.danger
  const daemonActiveJobCount = daemonSummary?.jobs.active ?? 0
  const daemonBackgroundJobCount = daemonSummary?.jobs.backgroundActive ?? 0
  const daemonStatusLabel = daemon?.running
    ? (daemonActiveJobCount > 0 ? 'ACTIVE' : 'READY')
    : daemon == null
      ? 'DAEMON'
      : 'OFFLINE'
  const daemonStatusDetail = daemon?.running && daemonBackgroundJobCount > 0
    ? `${daemonBackgroundJobCount} BG`
    : null
  const summarizedTasks = useMemo(() => summarizeDaemonTaskRows(daemonSummary?.jobs.recent ?? []), [daemonSummary?.jobs.recent])
  const daemonStatusTextColor = daemon?.running && daemonActiveJobCount > 0
    ? theme.text.primary
    : daemonColor
  const daemonTitle = daemon?.running
    ? `CodeSurf daemon ${daemonActiveJobCount > 0 ? 'active' : 'ready'}${daemonBackgroundJobCount > 0 ? ` - ${daemonBackgroundJobCount} background task${daemonBackgroundJobCount === 1 ? '' : 's'}` : ''} - PID ${daemon.info?.pid ?? 'unknown'} - port ${daemon.info?.port ?? 'unknown'}`
    : 'CodeSurf daemon offline'

  return (
    <div
      title={title}
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        padding: '0 16px',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          minWidth: 0,
          width: 'min(760px, 100%)',
          justifyContent: 'flex-end',
          color: theme.text.secondary,
          fontFamily: fonts.secondary,
          fontSize: Math.max(10, fonts.secondarySize - 2),
          fontWeight: 500,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: 0.2,
        }}
      >
        <div
          ref={daemonRef}
          title={daemonTitle}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            whiteSpace: 'nowrap',
            minWidth: 0,
            position: 'relative',
            pointerEvents: 'auto',
          }}
        >
          <button
            type="button"
            onMouseEnter={() => {
              window.electron.system.daemonSummary().then(setDaemonSummary).catch(() => {})
            }}
            onClick={() => {
              if (!showDaemonSummary) {
                window.electron.system.daemonSummary().then(setDaemonSummary).catch(() => {})
              }
              setShowDaemonSummary(current => !current)
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              whiteSpace: 'nowrap',
              minWidth: 0,
              background: showDaemonSummary ? theme.surface.panelMuted : 'transparent',
              border: `1px solid ${showDaemonSummary ? theme.border.default : 'transparent'}`,
              color: daemonColor,
              borderRadius: 999,
              padding: '4px 8px',
              cursor: 'pointer',
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: daemonDot,
                boxShadow: daemon?.running ? `0 0 8px ${daemonDot}66` : 'none',
                flexShrink: 0,
              }}
            />
            <Cpu
              size={13}
              strokeWidth={2}
              aria-label={daemonTitle}
              style={{ color: daemonStatusTextColor, flexShrink: 0 }}
            />
            {daemonStatusDetail && (
              <span style={{ color: theme.text.secondary, fontWeight: 600, letterSpacing: 0.3, fontSize: Math.max(9, fonts.secondarySize - 3) }}>
                {daemonStatusDetail}
              </span>
            )}
          </button>
          {showDaemonSummary && (
            <div
              style={{
                position: 'absolute',
                right: 0,
                bottom: 'calc(100% + 10px)',
                width: 340,
                maxWidth: 'min(340px, calc(100vw - 40px))',
                background: theme.surface.panel,
                border: `1px solid ${theme.border.default}`,
                borderRadius: 14,
                boxShadow: theme.mode === 'light'
                  ? '0 18px 40px rgba(0,0,0,0.12)'
                  : '0 18px 40px rgba(0,0,0,0.45)',
                padding: '12px 14px',
                pointerEvents: 'auto',
                zIndex: 5,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: fonts.secondarySize, fontWeight: 700, color: theme.text.primary }}>
                    {daemonActiveJobCount > 0 ? 'Active tasks' : 'Daemon summary'}
                  </span>
                  <span style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled }}>
                    {daemonSummary?.running
                      ? `PID ${daemonSummary.info?.pid ?? '—'} · port ${daemonSummary.info?.port ?? '—'}`
                      : 'Daemon offline'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    window.electron.system.daemonSummary().then(setDaemonSummary).catch(() => {})
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: theme.text.muted,
                    cursor: 'pointer',
                    fontSize: Math.max(10, fonts.secondarySize - 1),
                    padding: 0,
                  }}
                >
                  Refresh
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 8, marginBottom: 12 }}>
                {[
                  { label: 'Active', value: daemonSummary?.jobs.active ?? 0, color: theme.status.success },
                  { label: 'Bg', value: daemonSummary?.jobs.backgroundActive ?? 0, color: theme.accent.base },
                  { label: 'Done', value: daemonSummary?.jobs.completed ?? 0, color: theme.text.secondary },
                  { label: 'Failed', value: daemonSummary?.jobs.failed ?? 0, color: theme.status.danger },
                  { label: 'Total', value: daemonSummary?.jobs.total ?? 0, color: theme.text.primary },
                ].map(item => (
                  <div
                    key={item.label}
                    style={{
                      background: theme.surface.panelMuted,
                      border: `1px solid ${theme.border.subtle}`,
                      borderRadius: 10,
                      padding: '8px 10px',
                      minWidth: 0,
                    }}
                  >
                    <div style={{ fontSize: Math.max(9, fonts.secondarySize - 2), color: theme.text.disabled, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                      {item.label}
                    </div>
                    <div style={{ marginTop: 4, fontSize: fonts.secondarySize, fontWeight: 700, color: item.color }}>
                      {item.value}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                  Tasks
                </div>
                {summarizedTasks.length ? summarizedTasks.map(job => (
                  <button
                    type="button"
                    key={job.id}
                    onClick={() => {
                      onOpenDaemonTask?.(job)
                      setShowDaemonSummary(false)
                    }}
                    style={{
                      background: theme.surface.panelMuted,
                      border: `1px solid ${theme.border.subtle}`,
                      borderRadius: 10,
                      padding: '8px 10px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      width: '100%',
                      textAlign: 'left',
                      cursor: onOpenDaemonTask ? 'pointer' : 'default',
                      appearance: 'none',
                      font: 'inherit',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <span
                        style={{
                          fontSize: fonts.secondarySize,
                          color: theme.text.primary,
                          fontWeight: 600,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={job.taskLabel ?? job.id}
                      >
                        {job.taskLabel ?? `${job.provider ?? 'Unknown'} task`}
                      </span>
                      <span style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: statusTone(theme, job.status), textTransform: 'capitalize' }}>
                        {job.status}
                      </span>
                    </div>
                    <div style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled }}>
                      {[job.provider, job.model].filter(Boolean).join(' · ') || 'Unknown provider'}
                    </div>
                    <div style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled }}>
                      {job.workspaceDir ?? 'No workspace'} · {formatRelativeTime(job.updatedAt ?? job.requestedAt)}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled }}>
                        {job.runCount > 1 ? `${job.runCount} runs` : '1 run'}
                      </span>
                      <span style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.accent.base }}>
                        Open task
                      </span>
                    </div>
                  </button>
                )) : (
                  <div
                    style={{
                      background: theme.surface.panelMuted,
                      border: `1px solid ${theme.border.subtle}`,
                      borderRadius: 10,
                      padding: '10px 12px',
                      fontSize: fonts.secondarySize,
                      color: theme.text.disabled,
                    }}
                  >
                    No daemon jobs recorded yet.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {health === 'verbose' ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1, maxWidth: 240, overflow: 'hidden' }}>
              <div
                style={{
                  position: 'relative',
                  flex: 1,
                  height: 8,
                  borderRadius: 999,
                  overflow: 'hidden',
                  background: barBackground,
                  minWidth: 90,
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${usage.committedRatio * 100}%`,
                    background: theme.border.strong,
                    opacity: 0.35,
                  }}
                />
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${usage.ratio * 100}%`,
                    background: fillColor,
                    boxShadow: `0 0 10px ${fillColor}55`,
                  }}
                />
              </div>
              <span style={{ whiteSpace: 'nowrap', color: usage.ratio >= 0.85 ? theme.status.danger : theme.text.secondary }}>
                {formatBytes(usage.heapUsed)} / {formatBytes(usage.heapLimit || usage.heapTotal)}
              </span>
            </div>

            <span style={{ whiteSpace: 'nowrap', color: theme.text.secondary }}>
              RSS {formatBytes(stats?.rss ?? 0)}
            </span>

            <span style={{ whiteSpace: 'nowrap', color: theme.text.secondary }}>
              {Math.round(usage.ratio * 100)}%
            </span>
          </>
        ) : (
          <div style={{ pointerEvents: 'auto' }}>
            <Tooltip
              side="top"
              align="end"
              maxWidth={320}
              delay={150}
              content={
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
                  <div style={{ fontWeight: 700, letterSpacing: 0.5, color: '#fff' }}>MEMORY HEALTH</div>
                  <div
                    style={{
                      position: 'relative',
                      height: 6,
                      borderRadius: 999,
                      overflow: 'hidden',
                      background: 'rgba(255,255,255,0.08)',
                    }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: `${usage.committedRatio * 100}%`,
                        background: 'rgba(255,255,255,0.18)',
                      }}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: `${usage.ratio * 100}%`,
                        background: fillColor,
                      }}
                    />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 2, fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ color: '#888' }}>Heap</span>
                    <span>{formatBytes(usage.heapUsed)} / {formatBytes(usage.heapLimit || usage.heapTotal)} ({Math.round(usage.ratio * 100)}%)</span>
                    <span style={{ color: '#888' }}>Committed</span>
                    <span>{formatBytes(usage.heapTotal)}</span>
                    <span style={{ color: '#888' }}>RSS</span>
                    <span>{formatBytes(stats?.rss ?? 0)}</span>
                    <span style={{ color: '#888' }}>External</span>
                    <span>{formatBytes(stats?.external ?? 0)}</span>
                  </div>
                </div>
              }
            >
              <div
                role="status"
                aria-label={`Memory health ${Math.round(usage.ratio * 100)} percent, resident ${formatBytes(stats?.rss ?? 0)}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  whiteSpace: 'nowrap',
                  background: 'transparent',
                  border: `1px solid transparent`,
                  borderRadius: 999,
                  padding: '4px 8px',
                  color: theme.text.secondary,
                  cursor: 'default',
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: fillColor,
                    boxShadow: `0 0 6px ${fillColor}88`,
                    flexShrink: 0,
                  }}
                />
                <Activity size={13} strokeWidth={2} style={{ color: theme.text.secondary, flexShrink: 0 }} />
              </div>
            </Tooltip>
          </div>
        )}
      </div>
    </div>
  )
}

export default MainStatusBar

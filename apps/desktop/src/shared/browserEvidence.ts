export const BROWSER_EVIDENCE_DEFAULT_LIMIT = 200

export type BrowserEvidenceKind = 'console' | 'load-failure' | 'network-failure' | 'lifecycle'
export type BrowserEvidenceSeverity = 'debug' | 'info' | 'warning' | 'error'
export type BrowserConsoleLevel = 'debug' | 'info' | 'log' | 'warning' | 'error'

export type BrowserEvidenceInput = {
  tileId: string
  kind: BrowserEvidenceKind
  timestamp?: number
  message?: string
  url?: string
  source?: string
  line?: number
  column?: number
  level?: BrowserConsoleLevel | string | number | null
  severity?: BrowserEvidenceSeverity
  errorCode?: number
  details?: Record<string, unknown>
}

export type BrowserEvidenceEvent = {
  id: string
  tileId: string
  kind: BrowserEvidenceKind
  severity: BrowserEvidenceSeverity
  timestamp: number
  message: string
  url?: string
  source?: string
  line?: number
  column?: number
  level?: BrowserConsoleLevel | string | number | null
  errorCode?: number
  details?: Record<string, unknown>
}

export type BrowserEvidenceSummary = {
  total: number
  byKind: Partial<Record<BrowserEvidenceKind, number>>
  bySeverity: Partial<Record<BrowserEvidenceSeverity, number>>
  errorCount: number
  warningCount: number
  newestTimestamp: number | null
}

export type BrowserEvidencePageState = {
  tileId: string
  url: string
  title?: string
  isLoading: boolean
  mode?: string
}

export type BrowserEvidenceViewport = {
  width: number
  height: number
  deviceScaleFactor?: number
}

export type BrowserPageHealthStatus = 'healthy' | 'loading' | 'warning' | 'error'

export type BrowserPageHealth = {
  status: BrowserPageHealthStatus
  label: string
  issueCount: number
  errorCount: number
  warningCount: number
  eventCount: number
  newestTimestamp: number | null
}

export type BrowserEvidenceSnapshotInput = {
  tileId: string
  url: string
  title?: string
  isLoading?: boolean
  mode?: string
  capturedAt?: number
  viewport?: BrowserEvidenceViewport
  events: readonly BrowserEvidenceEvent[]
}

export type BrowserEvidenceSnapshot = {
  tileId: string
  capturedAt: number
  page: BrowserEvidencePageState
  viewport?: BrowserEvidenceViewport
  events: BrowserEvidenceEvent[]
  summary: BrowserEvidenceSummary
  health: BrowserPageHealth
}

function normalizeMessage(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function slugPart(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'event'
}

function normalizeConsoleLevel(level: BrowserEvidenceInput['level']): BrowserConsoleLevel | string | number | null | undefined {
  if (typeof level === 'number') {
    if (level <= 0) return 'debug'
    if (level === 1) return 'info'
    if (level === 2) return 'warning'
    return 'error'
  }
  if (typeof level !== 'string') return level

  const normalized = level.trim().toLowerCase()
  if (normalized === 'warn') return 'warning'
  if (normalized === 'verbose') return 'debug'
  if (normalized === 'log') return 'log'
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warning' || normalized === 'error') {
    return normalized
  }
  return normalized || null
}

function severityForInput(input: BrowserEvidenceInput): BrowserEvidenceSeverity {
  if (input.severity) return input.severity
  if (input.kind === 'load-failure' || input.kind === 'network-failure') return 'error'
  if (input.kind === 'lifecycle') return 'info'

  const level = normalizeConsoleLevel(input.level)
  if (level === 'error') return 'error'
  if (level === 'warning') return 'warning'
  if (level === 'debug') return 'debug'
  return 'info'
}

export function createBrowserEvidenceEvent(input: BrowserEvidenceInput): BrowserEvidenceEvent {
  const timestamp = Number.isFinite(input.timestamp) ? Number(input.timestamp) : Date.now()
  const level = normalizeConsoleLevel(input.level)
  const message = normalizeMessage(input.message || input.url || input.source || input.kind)
  const id = `${input.tileId}:${timestamp}:${input.kind}:${slugPart(message)}`

  return {
    id,
    tileId: input.tileId,
    kind: input.kind,
    severity: severityForInput(input),
    timestamp,
    message,
    ...(input.url ? { url: input.url } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(typeof input.line === 'number' ? { line: input.line } : {}),
    ...(typeof input.column === 'number' ? { column: input.column } : {}),
    ...(level !== undefined ? { level } : {}),
    ...(typeof input.errorCode === 'number' ? { errorCode: input.errorCode } : {}),
    ...(input.details ? { details: input.details } : {}),
  }
}

export function appendBrowserEvidence(
  existing: readonly BrowserEvidenceEvent[],
  event: BrowserEvidenceEvent | BrowserEvidenceInput,
  limit = BROWSER_EVIDENCE_DEFAULT_LIMIT,
): BrowserEvidenceEvent[] {
  const max = Math.max(0, Math.floor(limit))
  if (max === 0) return []

  const normalized = 'id' in event && 'severity' in event
    ? event
    : createBrowserEvidenceEvent(event)
  const next = [...existing, normalized]
  return next.length > max ? next.slice(next.length - max) : next
}

export function summarizeBrowserEvidence(events: readonly BrowserEvidenceEvent[]): BrowserEvidenceSummary {
  const byKind: Partial<Record<BrowserEvidenceKind, number>> = {}
  const bySeverity: Partial<Record<BrowserEvidenceSeverity, number>> = {}
  let newestTimestamp: number | null = null

  for (const event of events) {
    byKind[event.kind] = (byKind[event.kind] ?? 0) + 1
    bySeverity[event.severity] = (bySeverity[event.severity] ?? 0) + 1
    if (newestTimestamp === null || event.timestamp > newestTimestamp) {
      newestTimestamp = event.timestamp
    }
  }

  return {
    total: events.length,
    byKind,
    bySeverity,
    errorCount: bySeverity.error ?? 0,
    warningCount: bySeverity.warning ?? 0,
    newestTimestamp,
  }
}

export function createBrowserPageHealth(summary: BrowserEvidenceSummary, isLoading = false): BrowserPageHealth {
  const errorCount = summary.errorCount
  const warningCount = summary.warningCount
  const issueCount = errorCount + warningCount

  if (errorCount > 0) {
    return {
      status: 'error',
      label: errorCount === 1 ? '1 error' : `${errorCount} errors`,
      issueCount,
      errorCount,
      warningCount,
      eventCount: summary.total,
      newestTimestamp: summary.newestTimestamp,
    }
  }

  if (warningCount > 0) {
    return {
      status: 'warning',
      label: warningCount === 1 ? '1 warning' : `${warningCount} warnings`,
      issueCount,
      errorCount,
      warningCount,
      eventCount: summary.total,
      newestTimestamp: summary.newestTimestamp,
    }
  }

  if (isLoading) {
    return {
      status: 'loading',
      label: 'Loading',
      issueCount,
      errorCount,
      warningCount,
      eventCount: summary.total,
      newestTimestamp: summary.newestTimestamp,
    }
  }

  return {
    status: 'healthy',
    label: summary.total === 0 ? 'No evidence yet' : 'No issues',
    issueCount,
    errorCount,
    warningCount,
    eventCount: summary.total,
    newestTimestamp: summary.newestTimestamp,
  }
}

function normalizeViewport(input: BrowserEvidenceSnapshotInput['viewport']): BrowserEvidenceViewport | undefined {
  if (!input) return undefined
  const width = Math.round(Number(input.width))
  const height = Math.round(Number(input.height))
  const deviceScaleFactor = Number(input.deviceScaleFactor)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return {
    width,
    height,
    ...(Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0 ? { deviceScaleFactor } : {}),
  }
}

export function createBrowserEvidenceSnapshot(input: BrowserEvidenceSnapshotInput): BrowserEvidenceSnapshot {
  const events = [...input.events]
  const summary = summarizeBrowserEvidence(events)
  const capturedAt = Number.isFinite(input.capturedAt) ? Number(input.capturedAt) : Date.now()
  const viewport = normalizeViewport(input.viewport)

  return {
    tileId: input.tileId,
    capturedAt,
    page: {
      tileId: input.tileId,
      url: input.url,
      ...(input.title ? { title: input.title } : {}),
      isLoading: Boolean(input.isLoading),
      ...(input.mode ? { mode: input.mode } : {}),
    },
    ...(viewport ? { viewport } : {}),
    events,
    summary,
    health: createBrowserPageHealth(summary, Boolean(input.isLoading)),
  }
}

function formatEvidenceLine(event: BrowserEvidenceEvent): string {
  const parts = [
    `- [${event.severity}] ${event.kind}: ${event.message}`,
    event.url ? `(${event.url})` : '',
    event.source ? `source=${event.source}` : '',
    typeof event.line === 'number' ? `line=${event.line}` : '',
    typeof event.errorCode === 'number' ? `code=${event.errorCode}` : '',
  ].filter(Boolean)
  return parts.join(' ')
}

export function formatBrowserEvidenceReport(snapshot: BrowserEvidenceSnapshot, maxEvents = 20): string {
  const lines = [
    '# Browser QA Evidence',
    '',
    `Tile: ${snapshot.tileId}`,
    `URL: ${snapshot.page.url || 'unknown'}`,
    ...(snapshot.page.title ? [`Title: ${snapshot.page.title}`] : []),
    ...(snapshot.viewport ? [`Viewport: ${snapshot.viewport.width}×${snapshot.viewport.height}${snapshot.viewport.deviceScaleFactor ? ` @${snapshot.viewport.deviceScaleFactor}x` : ''}`] : []),
    `Status: ${snapshot.health.status} (${snapshot.health.label})`,
    `Events: ${snapshot.summary.total}; errors: ${snapshot.summary.errorCount}; warnings: ${snapshot.summary.warningCount}`,
    `Captured: ${new Date(snapshot.capturedAt).toISOString()}`,
    '',
    '## Recent evidence',
  ]

  const recent = snapshot.events.slice(-maxEvents).reverse()
  if (recent.length === 0) {
    lines.push('- No browser evidence captured yet.')
  } else {
    for (const event of recent) {
      lines.push(formatEvidenceLine(event))
    }
  }

  return lines.join('\n')
}

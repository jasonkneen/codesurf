const DEFAULT_MAX_EVENTS = 120
const STATUS_RANK = {
  healthy: 0,
  loading: 1,
  warning: 2,
  error: 3,
}

function nowMs(options) {
  return Number.isFinite(options && options.now) ? Number(options.now) : Date.now()
}

function createWorkbenchState(options = {}) {
  const maxEvents = clampNumber(options.maxEvents, DEFAULT_MAX_EVENTS, 20, 500)
  return {
    maxEvents,
    browsers: {},
    browserOrder: [],
    report: '',
    updatedAt: null,
    capturesRequestedAt: null,
  }
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.round(number)))
}

function ensureBrowser(state, tileId) {
  const id = String(tileId || '').trim()
  if (!id) return null
  if (!state.browsers[id]) {
    state.browsers[id] = {
      tileId: id,
      page: null,
      health: null,
      summary: { total: 0, errorCount: 0, warningCount: 0, infoCount: 0 },
      events: [],
      latestSnapshot: null,
      lastReport: '',
      updatedAt: null,
    }
    state.browserOrder.push(id)
  }
  return state.browsers[id]
}

function extractTileId(busEvent) {
  const payload = isObject(busEvent && busEvent.payload) ? busEvent.payload : {}
  const fromSnapshot = payload.snapshot && payload.snapshot.tileId
  const fromEvent = payload.event && payload.event.tileId
  if (typeof fromSnapshot === 'string' && fromSnapshot.trim()) return fromSnapshot.trim()
  if (typeof fromEvent === 'string' && fromEvent.trim()) return fromEvent.trim()

  const source = typeof busEvent.source === 'string' ? busEvent.source : ''
  if (source.startsWith('browser:')) return source.slice('browser:'.length)

  const channel = typeof busEvent.channel === 'string' ? busEvent.channel : ''
  if (channel.startsWith('tile:')) return channel.slice('tile:'.length)
  return ''
}

function normalizeSummary(value) {
  const source = isObject(value) ? value : {}
  return {
    total: numberOrZero(source.total),
    errorCount: numberOrZero(source.errorCount),
    warningCount: numberOrZero(source.warningCount),
    infoCount: numberOrZero(source.infoCount),
  }
}

function normalizeHealth(value, summary) {
  const source = isObject(value) ? value : {}
  const status = ['healthy', 'loading', 'warning', 'error'].includes(source.status)
    ? source.status
    : deriveHealthStatus(summary || normalizeSummary(null), !!source.loading)
  return {
    status,
    label: typeof source.label === 'string' && source.label.trim()
      ? source.label
      : statusLabel(status),
    issueCount: numberOrZero(source.issueCount || ((summary && (summary.errorCount + summary.warningCount)) || 0)),
    loading: !!source.loading,
  }
}

function normalizePage(value) {
  const source = isObject(value) ? value : {}
  return {
    url: typeof source.url === 'string' ? source.url : '',
    title: typeof source.title === 'string' ? source.title : '',
    isLoading: !!source.isLoading,
    mode: source.mode === 'mobile' ? 'mobile' : 'desktop',
  }
}

function normalizeViewport(value) {
  const source = isObject(value) ? value : {}
  const width = Number(source.width)
  const height = Number(source.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  const deviceScaleFactor = Number(source.deviceScaleFactor)
  return {
    width: Math.round(width),
    height: Math.round(height),
    ...(Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0 ? { deviceScaleFactor } : {}),
  }
}

function normalizeEvidenceEvent(value, fallbackTileId) {
  if (!isObject(value)) return null
  const severity = ['error', 'warning', 'info'].includes(value.severity) ? value.severity : 'info'
  return {
    id: typeof value.id === 'string' && value.id ? value.id : `event-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    tileId: typeof value.tileId === 'string' && value.tileId ? value.tileId : fallbackTileId,
    timestamp: Number.isFinite(value.timestamp) ? Number(value.timestamp) : Date.now(),
    severity,
    kind: typeof value.kind === 'string' && value.kind ? value.kind : 'unknown',
    message: typeof value.message === 'string' ? value.message : String(value.message || ''),
    source: typeof value.source === 'string' ? value.source : '',
    url: typeof value.url === 'string' ? value.url : '',
  }
}

function normalizeSnapshot(value, fallbackTileId) {
  if (!isObject(value)) return null
  const summary = normalizeSummary(value.summary)
  return {
    tileId: typeof value.tileId === 'string' && value.tileId ? value.tileId : fallbackTileId,
    capturedAt: Number.isFinite(value.capturedAt) ? Number(value.capturedAt) : Date.now(),
    page: normalizePage(value.page),
    summary,
    health: normalizeHealth(value.health, summary),
    viewport: normalizeViewport(value.viewport),
    events: Array.isArray(value.events)
      ? value.events.map(event => normalizeEvidenceEvent(event, fallbackTileId)).filter(Boolean)
      : [],
  }
}

function applyBrowserBusEvent(state, busEvent) {
  if (!state || !isObject(busEvent)) return state
  const eventType = typeof busEvent.type === 'string' ? busEvent.type : ''
  if (!eventType.startsWith('browser.')) return state

  const tileId = extractTileId(busEvent)
  const browser = ensureBrowser(state, tileId)
  if (!browser) return state

  const payload = isObject(busEvent.payload) ? busEvent.payload : {}
  const timestamp = Number.isFinite(busEvent.timestamp) ? Number(busEvent.timestamp) : Date.now()

  if (payload.page) browser.page = normalizePage(payload.page)
  if (payload.summary) browser.summary = normalizeSummary(payload.summary)
  if (payload.health) browser.health = normalizeHealth(payload.health, browser.summary)

  if (eventType === 'browser.evidence' && payload.event) {
    const event = normalizeEvidenceEvent(payload.event, tileId)
    if (event) appendEvidenceEvent(state, browser, event)
  }

  if (eventType === 'browser.evidence.snapshot' && payload.snapshot) {
    const snapshot = normalizeSnapshot(payload.snapshot, tileId)
    if (snapshot) {
      browser.latestSnapshot = {
        reason: typeof payload.reason === 'string' ? payload.reason : 'snapshot',
        snapshot,
        capturedAt: snapshot.capturedAt,
      }
      browser.page = snapshot.page
      browser.summary = snapshot.summary
      browser.health = snapshot.health
      browser.events = snapshot.events.slice(-state.maxEvents)
    }
    if (typeof payload.report === 'string') browser.lastReport = payload.report
  }

  if (eventType === 'browser.page_health') {
    if (payload.page) browser.page = normalizePage(payload.page)
    if (payload.summary) browser.summary = normalizeSummary(payload.summary)
    if (payload.health) browser.health = normalizeHealth(payload.health, browser.summary)
  }

  browser.updatedAt = timestamp
  state.updatedAt = timestamp
  state.report = buildQaWorkbenchReport(state, { now: timestamp })
  return state
}

function appendEvidenceEvent(state, browser, event) {
  browser.events.push(event)
  if (browser.events.length > state.maxEvents) {
    browser.events.splice(0, browser.events.length - state.maxEvents)
  }
}

function getWorkbenchSummary(state) {
  const browsers = Object.values(state && state.browsers ? state.browsers : {})
  let totalEvents = 0
  let issueCount = 0
  let worstStatus = 'healthy'
  let latestUpdatedAt = null

  for (const browser of browsers) {
    const summary = normalizeSummary(browser.summary)
    const health = normalizeHealth(browser.health, summary)
    totalEvents += summary.total || browser.events.length
    issueCount += summary.errorCount + summary.warningCount
    if (rankStatus(health.status) > rankStatus(worstStatus)) worstStatus = health.status
    if (Number.isFinite(browser.updatedAt) && (!latestUpdatedAt || browser.updatedAt > latestUpdatedAt)) {
      latestUpdatedAt = browser.updatedAt
    }
  }

  if (browsers.length === 0) worstStatus = 'healthy'
  return {
    browserCount: browsers.length,
    totalEvents,
    issueCount,
    healthStatus: worstStatus,
    updatedAt: latestUpdatedAt,
  }
}

function buildQaWorkbenchReport(state, options = {}) {
  const generatedAt = nowMs(options)
  const includeBrowserReports = options.includeBrowserReports !== false
  const summary = getWorkbenchSummary(state)
  const lines = []

  lines.push('# QA Workbench')
  lines.push('')
  lines.push(`Generated: ${new Date(generatedAt).toLocaleString()}`)
  lines.push(`Browsers: ${summary.browserCount}`)
  lines.push(`Evidence events: ${summary.totalEvents}`)
  lines.push(`Issues: ${summary.issueCount}`)
  lines.push(`Overall health: ${summary.healthStatus}`)
  lines.push('')

  if (!state || !Array.isArray(state.browserOrder) || state.browserOrder.length === 0) {
    lines.push('No browser evidence captured yet.')
    return lines.join('\n').trim()
  }

  for (const tileId of state.browserOrder) {
    const browser = state.browsers[tileId]
    if (!browser) continue
    const page = normalizePage(browser.page)
    const summary = normalizeSummary(browser.summary)
    const health = normalizeHealth(browser.health, summary)
    const events = Array.isArray(browser.events) ? browser.events.slice(-10).reverse() : []
    const viewport = browser.latestSnapshot && browser.latestSnapshot.snapshot
      ? normalizeViewport(browser.latestSnapshot.snapshot.viewport)
      : null

    lines.push(`## Browser: ${tileId}`)
    lines.push(`Health: ${health.status}${health.label ? ` (${health.label})` : ''}`)
    lines.push(`URL: ${page.url || '—'}`)
    if (page.title) lines.push(`Title: ${page.title}`)
    lines.push(`Mode: ${page.mode}${page.isLoading ? ' / loading' : ''}`)
    if (viewport) lines.push(`Viewport: ${viewport.width}×${viewport.height}${viewport.deviceScaleFactor ? ` @${viewport.deviceScaleFactor}x` : ''}`)
    lines.push(`Summary: ${summary.errorCount} errors, ${summary.warningCount} warnings, ${summary.total} events`)
    lines.push('')

    if (events.length === 0) {
      lines.push('- No recent evidence events for this browser.')
    } else {
      lines.push('### Recent evidence')
      for (const event of events) {
        const stamp = Number.isFinite(event.timestamp) ? new Date(event.timestamp).toLocaleTimeString() : 'unknown time'
        lines.push(`- [${event.severity}] ${event.kind}: ${event.message || '(empty)'} (${stamp})`)
        if (event.url && event.url !== page.url) lines.push(`  URL: ${event.url}`)
      }
    }
    lines.push('')

    if (includeBrowserReports && browser.lastReport) {
      lines.push('### Latest Browser Report')
      lines.push(browser.lastReport.trim())
      lines.push('')
    }
  }

  return lines.join('\n').trim()
}

function buildChatSurfacePayload(state, options = {}) {
  return {
    kind: 'text',
    data: buildQaWorkbenchReport(state, options),
    mime: 'text/markdown',
    ext: 'md',
  }
}

function buildVisualFixHandoff(state, options = {}) {
  const generatedAt = nowMs(options)
  const report = buildQaWorkbenchReport(state, options)
  const summary = getWorkbenchSummary(state)
  const browsers = (state && Array.isArray(state.browserOrder) ? state.browserOrder : [])
    .map(tileId => state.browsers[tileId])
    .filter(Boolean)
    .map(browser => {
      const snapshot = browser.latestSnapshot && browser.latestSnapshot.snapshot ? browser.latestSnapshot.snapshot : null
      const page = normalizePage(snapshot ? snapshot.page : browser.page)
      const browserSummary = normalizeSummary(snapshot ? snapshot.summary : browser.summary)
      const health = normalizeHealth(snapshot ? snapshot.health : browser.health, browserSummary)
      const events = Array.isArray(snapshot ? snapshot.events : browser.events) ? (snapshot ? snapshot.events : browser.events).slice(-12) : []
      return {
        tileId: browser.tileId,
        page,
        health,
        summary: browserSummary,
        viewport: snapshot ? normalizeViewport(snapshot.viewport) : null,
        latestSnapshotAt: snapshot ? snapshot.capturedAt : null,
        recentEvents: events.map(event => normalizeEvidenceEvent(event, browser.tileId)).filter(Boolean),
      }
    })

  const prompt = [
    'Fix this frontend using the QA Workbench browser evidence below.',
    'Treat console errors, failed loads, broken navigation, responsive overflow, and warning evidence as acceptance criteria.',
    'If screenshots or Sketch visual refs are attached in Builder, match their visible hierarchy, spacing, typography, and state while resolving this QA evidence.',
    'Return a polished corrected implementation or Builder HTML variant only; do not hand-wave around runtime evidence.',
  ].join(' ')

  return {
    kind: 'qa-workbench.visual_fix_handoff',
    prompt,
    report,
    summary,
    browsers,
    generatedAt,
  }
}

function serializeWorkbenchState(state, options = {}) {
  const report = buildQaWorkbenchReport(state, options)
  state.report = report
  return {
    summary: getWorkbenchSummary(state),
    browsers: state.browserOrder.map(tileId => state.browsers[tileId]).filter(Boolean),
    browserOrder: state.browserOrder.slice(),
    report,
    updatedAt: state.updatedAt,
    capturesRequestedAt: state.capturesRequestedAt,
  }
}

function rankStatus(status) {
  return STATUS_RANK[status] ?? 0
}

function deriveHealthStatus(summary, loading) {
  if (summary.errorCount > 0) return 'error'
  if (summary.warningCount > 0) return 'warning'
  if (loading) return 'loading'
  return 'healthy'
}

function statusLabel(status) {
  if (status === 'error') return 'Errors detected'
  if (status === 'warning') return 'Warnings detected'
  if (status === 'loading') return 'Loading'
  return 'Healthy'
}

function numberOrZero(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

exports.createWorkbenchState = createWorkbenchState
exports.applyBrowserBusEvent = applyBrowserBusEvent
exports.buildQaWorkbenchReport = buildQaWorkbenchReport
exports.buildChatSurfacePayload = buildChatSurfacePayload
exports.buildVisualFixHandoff = buildVisualFixHandoff
exports.getWorkbenchSummary = getWorkbenchSummary
exports.serializeWorkbenchState = serializeWorkbenchState
exports.normalizeEvidenceEvent = normalizeEvidenceEvent

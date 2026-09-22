/**
 * Codex usage reader - parses ~/.codex/sessions/YYYY/MM/DD/*.jsonl files for
 * per-session token totals and the most recent rate-limit window snapshot.
 *
 * Ported from dpcode's `apps/server/src/providerUsageSnapshot.ts` (Codex
 * branch). Adapted to codesurf's UsageSnapshot type and async/await style
 * (no Effect runtime).
 *
 * The Codex CLI writes a `token_count` event_msg into the JSONL transcript
 * after each turn. The latest such event holds the freshest `rate_limits`
 * blob (primary = 5h window, secondary = Weekly window). We aggregate token
 * totals across recent sessions to produce 24h/7d/30d rolling counters.
 */
import { promises as fs } from 'fs'
import type { Dirent, Stats } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { UsageSnapshot, UsageWindow } from './types'

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const LOOKBACK_DAYS = 30
const LOOKBACK_7D_MS = 7 * ONE_DAY_MS
const LOOKBACK_30D_MS = LOOKBACK_DAYS * ONE_DAY_MS
const MAX_RECENT_FILES = 2_000

interface CodexSessionSummary {
  timestampMs: number
  totalTokens: number
  windows: UsageWindow[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asNonNegativeNumber(value: unknown): number | undefined {
  const parsed = asFiniteNumber(value)
  return parsed !== undefined && parsed >= 0 ? parsed : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

async function safeReadDir(path: string): Promise<ReadonlyArray<Dirent>> {
  try {
    return await fs.readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

async function safeStat(path: string): Promise<Stats | null> {
  try {
    return await fs.stat(path)
  } catch {
    return null
  }
}

async function listRecentFiles(paths: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
  const filesWithStats = await Promise.all(
    paths.map(async path => ({
      path,
      mtimeMs: (await safeStat(path))?.mtimeMs ?? 0,
    })),
  )
  return filesWithStats
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, MAX_RECENT_FILES)
    .map(entry => entry.path)
}

async function listRecentCodexSessionFiles(sessionsRoot: string): Promise<ReadonlyArray<string>> {
  const now = new Date()
  const candidates: string[] = []
  for (let offset = 0; offset <= LOOKBACK_DAYS; offset += 1) {
    const current = new Date(now)
    current.setDate(now.getDate() - offset)
    const dayDir = join(
      sessionsRoot,
      `${current.getFullYear()}`,
      `${String(current.getMonth() + 1).padStart(2, '0')}`,
      `${String(current.getDate()).padStart(2, '0')}`,
    )
    const entries = await safeReadDir(dayDir)
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        candidates.push(join(dayDir, entry.name))
      }
    }
  }
  return listRecentFiles(candidates)
}

function readCodexTotalTokens(payload: Record<string, unknown>): number {
  const info = asRecord(payload.info)
  const totalUsage =
    asRecord(info?.total_token_usage) ??
    asRecord(info?.totalTokenUsage) ??
    asRecord(info?.total) ??
    asRecord(payload.total_token_usage) ??
    asRecord(payload.totalTokenUsage) ??
    asRecord(payload.total)
  return (
    asNonNegativeNumber(totalUsage?.total_tokens) ??
    asNonNegativeNumber(totalUsage?.totalTokens) ??
    asNonNegativeNumber(info?.total_tokens) ??
    asNonNegativeNumber(info?.totalTokens) ??
    asNonNegativeNumber(payload.total_tokens) ??
    asNonNegativeNumber(payload.totalTokens) ??
    0
  )
}

function normalizeCodexWindow(label: string, source: Record<string, unknown> | null): UsageWindow | null {
  if (!source) return null
  const usedPercent = asNonNegativeNumber(source.used_percent ?? source.usedPercent)
  const windowDurationMins = asNonNegativeNumber(source.window_minutes ?? source.windowMinutes)
  const resetsAt =
    asString(source.resets_at ?? source.resetsAt) ??
    asString(source.next_reset_at ?? source.nextResetAt)
  if (usedPercent === undefined && windowDurationMins === undefined && !resetsAt) return null
  const window: UsageWindow = { window: label }
  if (usedPercent !== undefined) window.usedPercent = Math.min(100, Math.max(0, usedPercent))
  if (resetsAt) window.resetsAt = resetsAt
  if (windowDurationMins !== undefined) window.windowDurationMins = windowDurationMins
  return window
}

function normalizeCodexWindows(value: unknown): UsageWindow[] {
  const rateLimits = asRecord(value)
  if (!rateLimits) return []
  const windows: UsageWindow[] = []
  const primary = normalizeCodexWindow('5h', asRecord(rateLimits.primary))
  const secondary = normalizeCodexWindow('Weekly', asRecord(rateLimits.secondary))
  if (primary) windows.push(primary)
  if (secondary) windows.push(secondary)
  return windows
}

async function readCodexSessionSummary(path: string): Promise<CodexSessionSummary | null> {
  let fileContents: string
  try {
    fileContents = await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
  let latest: CodexSessionSummary | null = null
  const lines = fileContents.split(/\r?\n/u)
  for (const line of lines) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const record = asRecord(parsed)
    if (!record || record.type !== 'event_msg') continue
    const payload = asRecord(record.payload)
    if (!payload || payload.type !== 'token_count') continue
    const timestampMs = parseTimestampMs(record.timestamp ?? payload.timestamp)
    if (timestampMs === null) continue
    const summary: CodexSessionSummary = {
      timestampMs,
      totalTokens: readCodexTotalTokens(payload),
      windows: normalizeCodexWindows(payload.rate_limits ?? payload.rateLimits),
    }
    if (!latest || summary.timestampMs > latest.timestampMs) latest = summary
  }
  return latest
}

/**
 * Build a usage snapshot from on-disk Codex sessions.
 *
 * Returns null if the codex home directory is missing or no sessions have a
 * parseable token_count event in the lookback window. Callers should treat
 * null as "no Codex usage data available" and surface a graceful empty state.
 */
export async function readCodexUsageSnapshot(opts?: {
  homePath?: string
}): Promise<UsageSnapshot | null> {
  const codexHome =
    opts?.homePath?.trim() || process.env.CODEX_HOME || join(homedir(), '.codex')
  const sessionsRoot = join(codexHome, 'sessions')
  const sessionFiles = await listRecentCodexSessionFiles(sessionsRoot)
  if (sessionFiles.length === 0) return null

  const summaries: CodexSessionSummary[] = []
  for (const file of sessionFiles) {
    const summary = await readCodexSessionSummary(file)
    if (summary) summaries.push(summary)
  }
  if (summaries.length === 0) return null

  const latest = summaries.reduce((max, current) =>
    current.timestampMs > max.timestampMs ? current : max,
  )
  const nowMs = Date.now()
  const recent24h = summaries.filter(s => s.timestampMs >= nowMs - ONE_DAY_MS)
  const recent7d = summaries.filter(s => s.timestampMs >= nowMs - LOOKBACK_7D_MS)
  const recent30d = summaries.filter(s => s.timestampMs >= nowMs - LOOKBACK_30D_MS)

  return {
    provider: 'codex',
    updatedAt: new Date(latest.timestampMs).toISOString(),
    source: 'session-archive',
    windows: latest.windows,
    totals: {
      tokens24h: recent24h.reduce((sum, s) => sum + s.totalTokens, 0),
      tokens7d: recent7d.reduce((sum, s) => sum + s.totalTokens, 0),
      tokens30d: recent30d.reduce((sum, s) => sum + s.totalTokens, 0),
      sessions24h: recent24h.length,
      sessions7d: recent7d.length,
      sessions30d: recent30d.length,
    },
  }
}

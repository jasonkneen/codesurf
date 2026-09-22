/**
 * Claude usage reader - parses ~/.claude/projects/<project>/<session>.jsonl
 * transcripts for per-message token totals.
 *
 * Ported from dpcode's `apps/server/src/providerUsageSnapshot.ts` (Claude
 * branch). Two important differences from the Codex reader:
 *
 *   1. Claude's transcripts emit token usage on every assistant message and
 *      every tool result, not in a single per-session summary event. We
 *      dedupe by (sessionId, requestId|messageId|uuid) so retries don't
 *      double-count.
 *
 *   2. Claude transcripts do NOT include rate-limit windows. The 5h /
 *      seven_day caps are emitted only as live `account.rate-limits.updated`
 *      events during a turn. So this reader returns `windows: []` and
 *      relies on the live-event path (Slice 2) to populate them.
 *
 * Returning empty windows is intentional: the renderer's status bar still
 * shows a useful "tokens used in last 24h/7d/30d" badge even before any
 * live event has fired this app session.
 */
import { promises as fs } from 'fs'
import type { Dirent, Stats } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { UsageSnapshot } from './types'

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const LOOKBACK_7D_MS = 7 * ONE_DAY_MS
const LOOKBACK_30D_MS = 30 * ONE_DAY_MS
const MAX_RECENT_FILES = 2_000

interface ClaudeUsageSample {
  sessionId: string
  timestampMs: number
  totalTokens: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function asNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
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
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_RECENT_FILES)
    .map(e => e.path)
}

async function listClaudeTranscriptFiles(projectsRoot: string): Promise<ReadonlyArray<string>> {
  const candidates: string[] = []
  const projectEntries = await safeReadDir(projectsRoot)
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue
    const projectDir = join(projectsRoot, projectEntry.name)
    const transcriptEntries = await safeReadDir(projectDir)
    for (const transcript of transcriptEntries) {
      if (transcript.isFile() && transcript.name.endsWith('.jsonl')) {
        candidates.push(join(projectDir, transcript.name))
      }
    }
  }
  return listRecentFiles(candidates)
}

function readClaudeTotalTokens(value: unknown): number {
  const usage = asRecord(value)
  if (!usage) return 0
  const inputTokens =
    (asNonNegativeNumber(usage.input_tokens) ?? 0) +
    (asNonNegativeNumber(usage.cache_creation_input_tokens) ?? 0) +
    (asNonNegativeNumber(usage.cache_read_input_tokens) ?? 0)
  const outputTokens = asNonNegativeNumber(usage.output_tokens) ?? 0
  return asNonNegativeNumber(usage.total_tokens) ?? inputTokens + outputTokens
}

function readAssistantSample(record: Record<string, unknown>, fallbackKey: string): { dedupeKey: string; sample: ClaudeUsageSample } | null {
  if (record.type !== 'assistant') return null
  const message = asRecord(record.message)
  const usage = asRecord(message?.usage)
  const totalTokens = readClaudeTotalTokens(usage)
  const timestampMs = parseTimestampMs(record.timestamp)
  if (!usage || totalTokens <= 0 || timestampMs === null) return null
  const sessionId = asString(record.sessionId) ?? fallbackKey
  const dedupeKey =
    `${sessionId}:assistant:` +
    (asString(record.requestId) ??
      asString(message?.id) ??
      asString(record.uuid) ??
      fallbackKey)
  return { dedupeKey, sample: { sessionId, timestampMs, totalTokens } }
}

function readToolResultSample(record: Record<string, unknown>, fallbackKey: string): { dedupeKey: string; sample: ClaudeUsageSample } | null {
  const toolUseResult = asRecord(record.toolUseResult)
  const usage = asRecord(toolUseResult?.usage)
  const totalTokens = readClaudeTotalTokens(usage)
  const timestampMs = parseTimestampMs(record.timestamp)
  if (!toolUseResult || !usage || totalTokens <= 0 || timestampMs === null) return null
  const sessionId = asString(record.sessionId) ?? fallbackKey
  const dedupeKey =
    `${sessionId}:tool-result:` +
    (asString(record.uuid) ??
      asString(toolUseResult.agentId) ??
      asString(record.requestId) ??
      fallbackKey)
  return { dedupeKey, sample: { sessionId, timestampMs, totalTokens } }
}

async function readClaudeSamples(path: string): Promise<ReadonlyArray<ClaudeUsageSample>> {
  let fileContents: string
  try {
    fileContents = await fs.readFile(path, 'utf8')
  } catch {
    return []
  }
  const samples: ClaudeUsageSample[] = []
  const seen = new Set<string>()
  const lines = fileContents.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line || !line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const record = asRecord(parsed)
    if (!record) continue
    const fallbackKey = `${path}:${index}`
    const assistant = readAssistantSample(record, fallbackKey)
    if (assistant && !seen.has(assistant.dedupeKey)) {
      seen.add(assistant.dedupeKey)
      samples.push(assistant.sample)
    }
    const tool = readToolResultSample(record, fallbackKey)
    if (tool && !seen.has(tool.dedupeKey)) {
      seen.add(tool.dedupeKey)
      samples.push(tool.sample)
    }
  }
  return samples
}

/**
 * Build a usage snapshot from on-disk Claude transcripts.
 *
 * Returns null when no transcripts exist or none have parseable token usage.
 * `windows` is always empty; rate-limit windows arrive only via the live
 * `account.rate-limits.updated` event path wired in Slice 2.
 */
export async function readClaudeUsageSnapshot(opts?: {
  homePath?: string
}): Promise<UsageSnapshot | null> {
  const claudeHome = opts?.homePath?.trim() || join(homedir(), '.claude')
  const projectsRoot = join(claudeHome, 'projects')
  const transcriptFiles = await listClaudeTranscriptFiles(projectsRoot)
  if (transcriptFiles.length === 0) return null

  const samples: ClaudeUsageSample[] = []
  for (const file of transcriptFiles) {
    const fileSamples = await readClaudeSamples(file)
    samples.push(...fileSamples)
  }
  if (samples.length === 0) return null

  const nowMs = Date.now()
  const recent24h = samples.filter(s => s.timestampMs >= nowMs - ONE_DAY_MS)
  const recent7d = samples.filter(s => s.timestampMs >= nowMs - LOOKBACK_7D_MS)
  const recent30d = samples.filter(s => s.timestampMs >= nowMs - LOOKBACK_30D_MS)
  const latest = samples.reduce((max, current) =>
    current.timestampMs > max.timestampMs ? current : max,
  )

  return {
    provider: 'claude',
    updatedAt: new Date(latest.timestampMs).toISOString(),
    source: 'transcripts',
    windows: [],
    totals: {
      tokens24h: recent24h.reduce((sum, s) => sum + s.totalTokens, 0),
      tokens7d: recent7d.reduce((sum, s) => sum + s.totalTokens, 0),
      tokens30d: recent30d.reduce((sum, s) => sum + s.totalTokens, 0),
      sessions24h: new Set(recent24h.map(s => s.sessionId)).size,
      sessions7d: new Set(recent7d.map(s => s.sessionId)).size,
      sessions30d: new Set(recent30d.map(s => s.sessionId)).size,
    },
  }
}

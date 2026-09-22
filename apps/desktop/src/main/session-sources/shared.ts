import { createReadStream, promises as fs } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'
import type { AggregatedSessionEntry, SessionScope } from '../../shared/session-types.ts'
import { CODESURF_HOME } from '../paths.ts'

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ImportedChatMessage {
  id: string
  role: ChatRole
  content: string
  timestamp: number
  thinking?: ImportedThinkingBlock
  toolBlocks?: ImportedToolBlock[]
  contentBlocks?: ImportedContentBlock[]
}

export interface ImportedChatState {
  provider: string
  model: string
  sessionId: string | null
  messages: ImportedChatMessage[]
}

export interface CachedExternalSessionState {
  mtimeMs: number
  size: number
  state: ImportedChatState | null
}

export interface ImportedThinkingBlock {
  content: string
  done: boolean
}

export interface ImportedToolFileChange {
  path: string
  previousPath?: string
  changeType: 'add' | 'update' | 'delete' | 'move'
  additions: number
  deletions: number
  diff: string
}

export interface ImportedToolCommandEntry {
  label: string
  command?: string
  output?: string
  kind?: 'search' | 'read' | 'command'
}

export interface ImportedToolBlock {
  id: string
  name: string
  input: string
  summary?: string
  elapsed?: number
  status: 'running' | 'done' | 'error'
  fileChanges?: ImportedToolFileChange[]
  commandEntries?: ImportedToolCommandEntry[]
}

export type ImportedContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; toolId: string }

export const STANDARD_CODESURF_SUBDIRS = ['sessions', 'agents', 'skills', 'tools', 'plugins', 'extensions'] as const
export const EXTERNAL_SESSION_CACHE_MS = 60_000
export const EXTERNAL_SESSION_STATE_CACHE_MAX_ENTRIES = 64
export const EXTERNAL_SESSION_FULL_STATE_CACHE_MAX_ENTRIES = 8
export const LARGE_EXTERNAL_SESSION_BYTES = 6 * 1024 * 1024
export const EXTERNAL_SESSION_HEAD_SAMPLE_BYTES = 128 * 1024
export const EXTERNAL_SESSION_TAIL_SAMPLE_BYTES = 4 * 1024 * 1024
export const MAX_SESSION_LISTING_JSON_BYTES = 2 * 1024 * 1024
export const MAX_SESSION_LISTING_TEXT_SAMPLE_BYTES = 16 * 1024
export const CLAUDE_SESSION_LISTING_HEAD_BYTES = 24 * 1024
export const CLAUDE_SESSION_LISTING_TAIL_BYTES = 96 * 1024
export const CLAUDE_SESSION_EXACT_SCAN_MAX_BYTES = 256 * 1024
export const CODEX_SESSION_LISTING_HEAD_BYTES = 24 * 1024
export const CODEX_SESSION_LISTING_TAIL_BYTES = 96 * 1024
export const CODEX_SESSION_EXACT_SCAN_MAX_BYTES = 256 * 1024
export const externalSessionCache = new Map<string, { at: number; entries: AggregatedSessionEntry[] }>()
export const externalSessionStateCache = new Map<string, CachedExternalSessionState>()
export const externalSessionFullStateCache = new Map<string, CachedExternalSessionState>()

export function isExternalSessionImportableInChat(
  messageCount: number | null | undefined,
  lastMessage: string | null | undefined,
): boolean {
  if (Number.isFinite(messageCount) && Number(messageCount) > 0) return true
  return typeof lastMessage === 'string' && lastMessage.trim().length > 0
}

export function getProjectCodeSurfDir(workspacePath: string): string {
  return join(workspacePath, '.codesurf')
}

export async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true })
}

export async function ensureCodeSurfStructure(workspacePath?: string | null): Promise<void> {
  await ensureDir(CODESURF_HOME)
  await Promise.all(STANDARD_CODESURF_SUBDIRS.map(dir => ensureDir(join(CODESURF_HOME, dir))))

  if (!workspacePath) return
  const projectDir = getProjectCodeSurfDir(workspacePath)
  await ensureDir(projectDir)
  await Promise.all(STANDARD_CODESURF_SUBDIRS.map(dir => ensureDir(join(projectDir, dir))))
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

export async function readJsonSafe(path: string, options?: { maxBytes?: number }): Promise<any | null> {
  try {
    if (options?.maxBytes != null) {
      const stat = await fs.stat(path)
      if (!stat.isFile() || stat.size > options.maxBytes) return null
    }
    const raw = await fs.readFile(path, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function readTextSafe(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
}

export async function readTextPreviewSafe(path: string, maxBytes = MAX_SESSION_LISTING_TEXT_SAMPLE_BYTES): Promise<string | null> {
  try {
    const handle = await fs.open(path, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes)
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
      return buffer.toString('utf8', 0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

export async function readTextTailSafe(path: string, maxBytes: number): Promise<string | null> {
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile()) return null
    const start = Math.max(0, stat.size - maxBytes)
    const length = stat.size - start
    const handle = await fs.open(path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, start)
      let text = buffer.toString('utf8', 0, bytesRead)
      if (start > 0) {
        const firstNewline = text.indexOf('\n')
        text = firstNewline === -1 ? '' : text.slice(firstNewline + 1)
      }
      return text
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

export async function statSafe(path: string): Promise<import('fs').Stats | null> {
  try {
    return await fs.stat(path)
  } catch {
    return null
  }
}

export function touchCachedExternalSessionState(
  cache: Map<string, CachedExternalSessionState>,
  maxEntries: number,
  key: string,
  value: CachedExternalSessionState,
): ImportedChatState | null {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value
    if (!oldestKey) break
    cache.delete(oldestKey)
  }
  return value.state
}

export async function getCachedExternalSessionChatState(
  cache: Map<string, CachedExternalSessionState>,
  maxEntries: number,
  cacheKey: string,
  filePath: string,
  load: () => Promise<ImportedChatState | null>,
): Promise<ImportedChatState | null> {
  const stat = await statSafe(filePath)
  if (!stat?.isFile()) {
    cache.delete(cacheKey)
    return null
  }

  const cached = cache.get(cacheKey)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return touchCachedExternalSessionState(cache, maxEntries, cacheKey, cached)
  }

  const state = await load()
  return touchCachedExternalSessionState(cache, maxEntries, cacheKey, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    state,
  })
}

export async function getFreshCachedExternalSessionChatState(
  cache: Map<string, CachedExternalSessionState>,
  maxEntries: number,
  cacheKey: string,
  filePath: string,
): Promise<ImportedChatState | null> {
  const stat = await statSafe(filePath)
  if (!stat?.isFile()) {
    cache.delete(cacheKey)
    return null
  }

  const cached = cache.get(cacheKey)
  if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) return null
  return touchCachedExternalSessionState(cache, maxEntries, cacheKey, cached)
}

export async function scanJsonlFile(
  filePath: string,
  onLine: (line: string, lineNumber: number) => void | Promise<void>,
): Promise<void> {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let lineNumber = 0

  try {
    for await (const line of lines) {
      if (!line) continue
      lineNumber += 1
      await onLine(line, lineNumber)
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}

export function truncate(text: string | null | undefined, length = 120): string | null {
  if (!text) return null
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > length ? normalized.slice(0, length) : normalized
}

export function epochMsFromUnknown(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return numeric < 10_000_000_000 ? Math.round(numeric * 1000) : Math.round(numeric)
}

export function isSessionTitleBoilerplateLine(line: string): boolean {
  const normalized = line.trim()
  if (!normalized) return true
  return /^(?:#\s*)?AGENTS\.md instructions for\b/i.test(normalized)
    || /^(?:#\s*)?CLAUDE\.md instructions for\b/i.test(normalized)
    || /^<\/?environment_context>$/i.test(normalized)
    || /^<INSTRUCTIONS>$/i.test(normalized)
    || /^<\/INSTRUCTIONS>$/i.test(normalized)
    || /^---\s*project-doc\s*---$/i.test(normalized)
    || /^#+\s*(?:Non-Negotiable Rules|GSDN Native Mode|Installed GSDN assets|Usage rules|Skills|Files mentioned by the user)\b/i.test(normalized)
    || /^Launching skill:/i.test(normalized)
    || /^Base directory for this skill:/i.test(normalized)
    || /^The `?\.codesurf\/DREAMING\.md`? has been written/i.test(normalized)
}

export function firstMeaningfulSessionTitleLine(text: string | null | undefined): string | null {
  const source = String(text ?? '').replace(/\r\n/g, '\n').trim()
  if (!source) return null

  const explicitRequest = source.match(/#+\s*My request for Codex:\s*([\s\S]+)/i)
  if (explicitRequest?.[1]?.trim()) return firstMeaningfulSessionTitleLine(explicitRequest[1])

  const userRequest = source.match(/^#+\s*User Request\s*\n([\s\S]+)/im)
  if (userRequest?.[1]?.trim()) return firstMeaningfulSessionTitleLine(userRequest[1])

  let insideInstructions = false
  let insideEnvironmentContext = false
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^<environment_context>$/i.test(line)) {
      insideEnvironmentContext = true
      continue
    }
    if (/^<\/environment_context>$/i.test(line)) {
      insideEnvironmentContext = false
      continue
    }
    if (insideEnvironmentContext) continue

    if (/<INSTRUCTIONS>/i.test(line)) {
      insideInstructions = true
      continue
    }
    if (/<\/INSTRUCTIONS>/i.test(line)) {
      insideInstructions = false
      continue
    }
    if (insideInstructions) continue

    const workspacePrompt = line.match(/^Workspace:\s+.+?\bPrimary path:\s+\S+\s+(.+)$/i)
    if (workspacePrompt?.[1]?.trim()) return workspacePrompt[1].trim()

    if (isSessionTitleBoilerplateLine(line)) continue
    return line
  }

  return null
}

export function sessionTitleFromText(fallback: string, text: string | null | undefined): string {
  const trimmed = firstMeaningfulSessionTitleLine(text) ?? text?.trim()
  if (!trimmed) return fallback
  return trimmed.split(/\r?\n/, 1)[0].slice(0, 80)
}

export function normalizeSessionPath(path: string | null | undefined): string {
  return String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

export function pathBelongsToWorkspace(workspacePath: string | null | undefined, sessionProjectPath: string | null | undefined): boolean {
  const workspace = normalizeSessionPath(workspacePath)
  const project = normalizeSessionPath(sessionProjectPath)
  if (!workspace || !project) return false
  return project === workspace || project.startsWith(`${workspace}/`)
}

export function pathScope(workspacePath: string | null | undefined, sessionProjectPath: string | null | undefined, fallback: SessionScope = 'user'): SessionScope {
  if (pathBelongsToWorkspace(workspacePath, sessionProjectPath)) return 'project'
  return fallback
}

export function extractProjectPathFromSessionText(text: string | null | undefined): string | null {
  const source = String(text ?? '')
  if (!source.trim()) return null

  const backtickWorkspace = source.match(/\bWorkspace:\s*`([^`]+)`/i)
  if (backtickWorkspace?.[1]?.startsWith('/')) return normalizeSessionPath(backtickWorkspace[1])

  const primaryPath = source.match(/\bPrimary path:\s*`?([^\s`]+)`?/i)
  if (primaryPath?.[1]?.startsWith('/')) return normalizeSessionPath(primaryPath[1])

  const cwd = source.match(/\b(?:cwd|projectPath|project_path|workspacePath|workspace_path)["':\s]+`?((?:\/[^`"'\s]+)+)`?/i)
  if (cwd?.[1]?.startsWith('/')) return normalizeSessionPath(cwd[1])

  return null
}

export function compareSessions(a: AggregatedSessionEntry, b: AggregatedSessionEntry): number {
  return b.updatedAt - a.updatedAt
}

export function humanizeSlug(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase())
}

export function roleFromUnknown(value: unknown): ChatRole | null {
  return value === 'user' || value === 'assistant' || value === 'system' ? value : null
}

export function makeImportedMessage(id: string, role: ChatRole, content: string, timestamp: number): ImportedChatMessage | null {
  const trimmed = content.trim()
  if (!trimmed) return null
  return { id, role, content: trimmed, timestamp }
}

export function makeImportedRichMessage(params: {
  id: string
  role: ChatRole
  content: string
  timestamp: number
  thinking?: ImportedThinkingBlock
  toolBlocks?: ImportedToolBlock[]
}): ImportedChatMessage | null {
  const trimmedContent = params.content.trim()
  const toolBlocks = params.toolBlocks?.filter(block => {
    return Boolean(block.name.trim())
      && (Boolean(block.input.trim()) || Boolean(block.summary?.trim()) || (block.fileChanges?.length ?? 0) > 0 || (block.commandEntries?.length ?? 0) > 0)
  }) ?? []
  const thinking = params.thinking && params.thinking.content.trim()
    ? { ...params.thinking, content: params.thinking.content.trim() }
    : undefined

  if (!trimmedContent && !thinking && toolBlocks.length === 0) return null

  const contentBlocks: ImportedContentBlock[] = []
  for (const block of toolBlocks) contentBlocks.push({ type: 'tool', toolId: block.id })
  if (trimmedContent) contentBlocks.push({ type: 'text', text: trimmedContent })

  return {
    id: params.id,
    role: params.role,
    content: trimmedContent,
    timestamp: params.timestamp,
    thinking,
    toolBlocks: toolBlocks.length > 0 ? toolBlocks : undefined,
    contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
  }
}

export function extractTextParts(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part
      if (typeof part?.text === 'string') return part.text
      if (typeof part?.content === 'string') return part.content
      if (typeof part?.value === 'string') return part.value
      if (typeof part?.input_text === 'string') return part.input_text
      if (typeof part?.output_text === 'string') return part.output_text
      return ''
    }).filter(Boolean).join('\n\n')
  }
  if (content && typeof content === 'object') {
    if (typeof (content as any).text === 'string') return (content as any).text
    if (typeof (content as any).content === 'string') return (content as any).content
    if (typeof (content as any).value === 'string') return (content as any).value
  }
  return ''
}

export function makeTranscriptTruncationMessage(provider: string, fileSizeBytes: number): ImportedChatMessage {
  const sizeMb = Math.max(1, Math.round(fileSizeBytes / (1024 * 1024)))
  const label = provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : 'CLI'
  return {
    id: `${provider}-truncated-notice`,
    role: 'system',
    content: `${label} transcript trimmed for faster loading. Showing the start of the conversation and recent activity from a ${sizeMb} MB session.`,
    timestamp: Date.now(),
  }
}

export function dedupeImportedMessages(messages: ImportedChatMessage[]): ImportedChatMessage[] {
  const out: ImportedChatMessage[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    const thinkingKey = message.thinking ? `${message.thinking.done ? '1' : '0'}::${message.thinking.content}` : ''
    const toolKey = (message.toolBlocks ?? [])
      .map(block => `${block.id}::${block.name}::${block.status}::${block.input}::${block.summary ?? ''}`)
      .join('\u0001')
    const key = `${message.role}::${message.timestamp}::${message.content}::${thinkingKey}::${toolKey}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(message)
  }
  return out
}

export function parseJsonlLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
}

export function parseJsonObject(raw: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : null
  } catch {
    return null
  }
}

export async function listFilesRecursive(root: string, predicate: (path: string) => boolean, maxDepth = 4): Promise<string[]> {
  const out: string[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let entries: Array<import('fs').Dirent> = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'deleted') continue
        await walk(fullPath, depth + 1)
      } else if (predicate(fullPath)) {
        out.push(fullPath)
      }
    }
  }

  await walk(root, 0)
  return out
}

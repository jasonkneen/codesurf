import { createReadStream, promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, extname, join } from 'path'
import { createInterface } from 'readline'
import Database from 'better-sqlite3'
import type { AggregatedSessionEntry, SessionScope, SessionSource } from '../shared/session-types'
import { CONTEX_HOME } from './paths'

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

const STANDARD_CODESURF_SUBDIRS = ['sessions', 'agents', 'skills', 'tools', 'plugins', 'extensions'] as const
const EXTERNAL_SESSION_CACHE_MS = 30_000
const MAX_SESSION_LISTING_JSON_BYTES = 2 * 1024 * 1024
const MAX_SESSION_LISTING_TEXT_SAMPLE_BYTES = 16 * 1024
const externalSessionCache = new Map<string, { at: number; entries: AggregatedSessionEntry[] }>()
const GENERIC_OPENCLAW_LABELS = new Set(['openclaw studio', 'openclawstudio', 'openclaw-tui', 'vibeclaw', 'heartbeat'])

function getProjectCodeSurfDir(workspacePath: string): string {
  return join(workspacePath, '.codesurf')
}

async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true })
}

export async function ensureCodeSurfStructure(workspacePath?: string | null): Promise<void> {
  await ensureDir(CONTEX_HOME)
  await Promise.all(STANDARD_CODESURF_SUBDIRS.map(dir => ensureDir(join(CONTEX_HOME, dir))))

  if (!workspacePath) return
  const projectDir = getProjectCodeSurfDir(workspacePath)
  await ensureDir(projectDir)
  await Promise.all(STANDARD_CODESURF_SUBDIRS.map(dir => ensureDir(join(projectDir, dir))))
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function readJsonSafe(path: string, options?: { maxBytes?: number }): Promise<any | null> {
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

async function readTextSafe(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function readTextPreviewSafe(path: string, maxBytes = MAX_SESSION_LISTING_TEXT_SAMPLE_BYTES): Promise<string | null> {
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

async function statSafe(path: string): Promise<import('fs').Stats | null> {
  try {
    return await fs.stat(path)
  } catch {
    return null
  }
}

async function scanJsonlFile(
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

function truncate(text: string | null | undefined, length = 120): string | null {
  if (!text) return null
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > length ? normalized.slice(0, length) : normalized
}

function sessionTitleFromText(fallback: string, text: string | null | undefined): string {
  const trimmed = text?.trim()
  if (!trimmed) return fallback
  return trimmed.split(/\r?\n/, 1)[0].slice(0, 80)
}

function pathScope(workspacePath: string | null | undefined, sessionProjectPath: string | null | undefined, fallback: SessionScope = 'user'): SessionScope {
  if (workspacePath && sessionProjectPath && workspacePath === sessionProjectPath) return 'project'
  return fallback
}

function compareSessions(a: AggregatedSessionEntry, b: AggregatedSessionEntry): number {
  return b.updatedAt - a.updatedAt
}

function humanizeSlug(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase())
}

function isGenericOpenClawLabel(value: string | null | undefined): boolean {
  if (!value) return true
  return GENERIC_OPENCLAW_LABELS.has(value.trim().toLowerCase())
}

function roleFromUnknown(value: unknown): ChatRole | null {
  return value === 'user' || value === 'assistant' || value === 'system' ? value : null
}

function makeImportedMessage(id: string, role: ChatRole, content: string, timestamp: number): ImportedChatMessage | null {
  const trimmed = content.trim()
  if (!trimmed) return null
  return { id, role, content: trimmed, timestamp }
}

function makeImportedRichMessage(params: {
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

function extractTextParts(content: unknown): string {
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

function truncateToolPreview(text: string | null | undefined, length = 800): string {
  if (!text) return ''
  return text.length > length ? `${text.slice(0, length)}\n…` : text
}

function sanitizeToolOutputText(text: string | null | undefined): string {
  if (!text) return ''

  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => {
      const trimmed = line.trim()
      return !(
        /^Chunk ID:/i.test(trimmed)
        || /^Wall time:/i.test(trimmed)
        || /^Process exited with code /i.test(trimmed)
        || /^Process running with session ID /i.test(trimmed)
        || /^Original token count:/i.test(trimmed)
        || /^Output:$/i.test(trimmed)
        || /^\[CodeSurf memory guard\] Older tool (output|summary) /i.test(trimmed)
      )
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractReasoningSummary(payload: any): string {
  if (!Array.isArray(payload?.summary)) return ''
  return payload.summary
    .map((entry: any) => typeof entry?.text === 'string' ? entry.text.trim() : '')
    .filter(Boolean)
    .join('\n\n')
}

function parseJsonObject(raw: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : null
  } catch {
    return null
  }
}

function extractCommandFromToolCall(name: string, rawInput: string): string {
  const parsed = parseJsonObject(rawInput)
  if (name === 'exec_command') return typeof parsed?.cmd === 'string' ? parsed.cmd : rawInput
  if (name === 'shell_command') return typeof parsed?.command === 'string' ? parsed.command : rawInput
  if (name === 'shell') {
    if (Array.isArray(parsed?.command)) return parsed.command.map((part: unknown) => String(part)).join(' ')
    if (typeof parsed?.command === 'string') return parsed.command
  }
  return rawInput
}

function extractApplyPatchText(rawInput: string): string | null {
  const beginIndex = rawInput.indexOf('*** Begin Patch')
  const endIndex = rawInput.lastIndexOf('*** End Patch')
  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) return null
  return rawInput.slice(beginIndex, endIndex + '*** End Patch'.length)
}

function parseApplyPatchFileChanges(patchText: string): ImportedToolFileChange[] {
  const lines = patchText.replace(/\r\n/g, '\n').split('\n')
  const changes: ImportedToolFileChange[] = []
  let current: (ImportedToolFileChange & { lines: string[] }) | null = null

  const flush = () => {
    if (!current) return
    current.diff = current.lines.join('\n').trim()
    current.additions = current.lines.filter(line => line.startsWith('+')).length
    current.deletions = current.lines.filter(line => line.startsWith('-')).length
    changes.push({
      path: current.path,
      previousPath: current.previousPath,
      changeType: current.changeType,
      additions: current.additions,
      deletions: current.deletions,
      diff: current.diff,
    })
    current = null
  }

  for (const line of lines) {
    if (line.startsWith('*** Add File: ')) {
      flush()
      current = {
        path: line.slice('*** Add File: '.length).trim(),
        changeType: 'add',
        additions: 0,
        deletions: 0,
        diff: '',
        lines: [line],
      }
      continue
    }
    if (line.startsWith('*** Update File: ')) {
      flush()
      current = {
        path: line.slice('*** Update File: '.length).trim(),
        changeType: 'update',
        additions: 0,
        deletions: 0,
        diff: '',
        lines: [line],
      }
      continue
    }
    if (line.startsWith('*** Delete File: ')) {
      flush()
      current = {
        path: line.slice('*** Delete File: '.length).trim(),
        changeType: 'delete',
        additions: 0,
        deletions: 0,
        diff: '',
        lines: [line],
      }
      continue
    }
    if (line.startsWith('*** Move to: ')) {
      if (current) {
        current.previousPath = current.path
        current.path = line.slice('*** Move to: '.length).trim()
        current.changeType = 'move'
        current.lines.push(line)
      }
      continue
    }
    if (line === '*** End Patch') {
      if (current) current.lines.push(line)
      flush()
      continue
    }
    if (current) current.lines.push(line)
  }

  flush()
  return changes
}

type ImportedCommandKind = 'search' | 'read' | 'command'

function classifyCommand(command: string): ImportedCommandKind {
  const normalized = command.trim()
  if (/(^|\s)(rg|grep|fd|findstr)\b/.test(normalized)) return 'search'
  if (/(^|\s)(cat|sed|head|tail|less|more|bat)\b/.test(normalized)) return 'read'
  if (/(^|\s)ls\b/.test(normalized)) return 'read'
  return 'command'
}

interface PendingImportedToolCall {
  id: string
  name: string
  input: string
  output?: string
  status: 'done' | 'error'
  fileChanges?: ImportedToolFileChange[]
  commandEntry?: ImportedToolCommandEntry
}

function buildImportedToolBlocks(calls: PendingImportedToolCall[]): ImportedToolBlock[] {
  const blocks: ImportedToolBlock[] = []
  const handledIds = new Set<string>()

  const fileChangeMap = new Map<string, ImportedToolFileChange>()
  for (const change of calls.flatMap(call => call.fileChanges ?? [])) {
    const key = `${change.path}::${change.previousPath ?? ''}::${change.changeType}`
    const existing = fileChangeMap.get(key)
    if (!existing) {
      fileChangeMap.set(key, { ...change })
      continue
    }
    existing.additions += change.additions
    existing.deletions += change.deletions
    existing.diff = `${existing.diff}\n\n${change.diff}`.trim()
  }
  const fileChanges = Array.from(fileChangeMap.values())
  if (fileChanges.length > 0) {
    blocks.push({
      id: 'tool-edits',
      name: `Edited ${fileChanges.length} file${fileChanges.length === 1 ? '' : 's'}`,
      input: calls.filter(call => (call.fileChanges?.length ?? 0) > 0).map(call => call.input).join('\n\n'),
      status: 'done',
      fileChanges,
    })
    for (const call of calls) {
      if ((call.fileChanges?.length ?? 0) > 0) handledIds.add(call.id)
    }
  }

  const exploreEntries = calls
    .filter(call => call.commandEntry && (call.commandEntry.kind === 'search' || call.commandEntry.kind === 'read'))
    .map(call => call.commandEntry!) 

  if (exploreEntries.length > 0) {
    const readCount = exploreEntries.filter(entry => entry.kind === 'read').length
    const searchCount = exploreEntries.filter(entry => entry.kind === 'search').length
    const labelParts: string[] = []
    if (readCount > 0) labelParts.push(`${readCount} file${readCount === 1 ? '' : 's'}`)
    if (searchCount > 0) labelParts.push(`${searchCount} search${searchCount === 1 ? '' : 'es'}`)

    blocks.push({
      id: 'tool-explore',
      name: `Explored ${labelParts.join(', ')}`,
      input: exploreEntries.map(entry => entry.command ?? entry.label).join('\n'),
      status: 'done',
      commandEntries: exploreEntries,
    })
    for (const call of calls) {
      if (call.commandEntry && (call.commandEntry.kind === 'search' || call.commandEntry.kind === 'read')) handledIds.add(call.id)
    }
  }

  for (const call of calls) {
    if (handledIds.has(call.id)) continue
    blocks.push({
      id: call.id,
      name: call.name,
      input: call.input,
      summary: truncateToolPreview(sanitizeToolOutputText(call.output), 240) || undefined,
      status: call.status,
      commandEntries: call.commandEntry ? [call.commandEntry] : undefined,
    })
  }

  return blocks
}

function parseCodexToolCall(payload: any): PendingImportedToolCall | null {
  const callId = typeof payload?.call_id === 'string' ? payload.call_id : null
  const toolName = typeof payload?.name === 'string' ? payload.name : null
  if (!callId || !toolName) return null

  const rawInput = typeof payload?.arguments === 'string'
    ? payload.arguments
    : typeof payload?.input === 'string'
      ? payload.input
      : ''
  const command = extractCommandFromToolCall(toolName, rawInput)
  const patchText = toolName === 'apply_patch'
    ? extractApplyPatchText(rawInput) ?? rawInput
    : toolName === 'shell'
      ? extractApplyPatchText(command)
      : null

  const fileChanges = patchText ? parseApplyPatchFileChanges(patchText) : undefined
  const normalizedName = fileChanges && fileChanges.length > 0 ? 'apply_patch' : toolName
  const commandEntry = !fileChanges && command.trim()
    ? {
      label: command.trim(),
      command: command.trim(),
      kind: classifyCommand(command.trim()),
    }
    : undefined

  return {
    id: callId,
    name: normalizedName,
    input: fileChanges && fileChanges.length > 0 ? patchText ?? rawInput : rawInput,
    status: payload?.status === 'errored' ? 'error' : 'done',
    fileChanges,
    commandEntry,
  }
}

async function listFilesRecursive(root: string, predicate: (path: string) => boolean, maxDepth = 4): Promise<string[]> {
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

function parseOpenClawKey(sessionKey: string): { agentId: string; route: string; groupId: string; isSubagent: boolean } {
  const parts = sessionKey.split(':')
  const agentId = parts[1] || 'main'
  const route = parts[2] || 'main'
  return {
    agentId,
    route,
    groupId: `openclaw:${agentId}`,
    isSubagent: route === 'subagent',
  }
}

function formatOpenClawTitle(agentId: string, sessionKey: string, meta: any): { title: string; detail: string; relatedGroupId: string; nestingLevel: number } {
  const parsed = parseOpenClawKey(sessionKey)
  const agentLabel = humanizeSlug(agentId)
  const preferred = typeof meta?.label === 'string' && meta.label.trim()
    ? meta.label.trim()
    : typeof meta?.origin?.label === 'string' && meta.origin.label.trim()
      ? meta.origin.label.trim()
      : ''

  let title = preferred
  if (isGenericOpenClawLabel(title)) {
    if (parsed.isSubagent) title = `Subagent ${meta?.sessionId ? String(meta.sessionId).slice(0, 8) : ''}`.trim()
    else if (parsed.route === 'cron') title = 'Scheduled task'
    else if (parsed.route === 'webchat') title = 'Web chat'
    else if (parsed.route === 'main') title = `${agentLabel} chat`
    else title = humanizeSlug(parsed.route)
  }

  const detailParts = ['OpenClaw', agentLabel]
  if (parsed.route !== 'main' && parsed.route !== 'subagent') detailParts.push(humanizeSlug(parsed.route))
  if (parsed.isSubagent) detailParts.push('Subagent')

  return {
    title,
    detail: detailParts.join(' · '),
    relatedGroupId: parsed.groupId,
    nestingLevel: parsed.isSubagent ? 1 : 0,
  }
}

async function listCodeSurfSessionFiles(workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const roots: Array<{ dir: string; scope: SessionScope }> = []
  if (workspacePath) roots.push({ dir: join(getProjectCodeSurfDir(workspacePath), 'sessions'), scope: 'project' })
  roots.push({ dir: join(CONTEX_HOME, 'sessions'), scope: 'user' })

  const entries: AggregatedSessionEntry[] = []

  for (const root of roots) {
    if (!(await fileExists(root.dir))) continue
    const files = await listFilesRecursive(root.dir, path => ['.json', '.jsonl', '.md', '.txt'].includes(extname(path).toLowerCase()), 3)

    for (const filePath of files) {
      const stat = await statSafe(filePath)
      if (!stat?.isFile()) continue

      let title = basename(filePath)
      let lastMessage: string | null = null
      let messageCount = 0
      let sessionId: string | null = basename(filePath, extname(filePath))
      let provider = 'codesurf'
      let model = ''
      const ext = extname(filePath).toLowerCase()

      if (ext === '.json') {
        const parsed = await readJsonSafe(filePath, { maxBytes: MAX_SESSION_LISTING_JSON_BYTES })
        if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed.messages)) {
            messageCount = parsed.messages.length
            const last = parsed.messages[parsed.messages.length - 1]
            lastMessage = truncate(typeof last?.content === 'string' ? last.content : extractTextParts(last?.content))
            title = sessionTitleFromText(title, lastMessage)
          } else if (Array.isArray(parsed.entries)) {
            messageCount = parsed.entries.length
          }
          if (typeof parsed.sessionId === 'string') sessionId = parsed.sessionId
          if (typeof parsed.provider === 'string') provider = parsed.provider
          if (typeof parsed.model === 'string') model = parsed.model
          if (typeof parsed.title === 'string' && parsed.title.trim()) title = parsed.title.trim()
        }
      } else if (ext === '.md' || ext === '.txt') {
        const raw = await readTextPreviewSafe(filePath)
        lastMessage = truncate(raw)
        title = sessionTitleFromText(title, raw)
      }

      entries.push({
        id: `codesurf-file:${filePath}`,
        source: 'codesurf',
        scope: root.scope,
        tileId: null,
        sessionId,
        provider,
        model,
        messageCount,
        lastMessage,
        updatedAt: stat.mtimeMs,
        filePath,
        title,
        projectPath: root.scope === 'project' ? workspacePath : null,
        sourceLabel: 'CodeSurf',
        sourceDetail: root.scope === 'project' ? 'Project session' : 'User session',
        canOpenInChat: true,
        canOpenInApp: false,
      })
    }
  }

  return entries
}

async function listClaudeSessions(workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const dir = join(homedir(), '.claude', 'transcripts')
  if (!(await fileExists(dir))) return []

  const files = (await fs.readdir(dir))
    .filter(name => name.endsWith('.jsonl'))
    .map(name => join(dir, name))

  const withStat = await Promise.all(files.map(async filePath => ({ filePath, stat: await statSafe(filePath) })))
  const recent = withStat
    .filter(item => item.stat?.isFile())
    .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0))
    .slice(0, 80)

  const entries = await Promise.all(recent.map(async ({ filePath, stat }) => {
    let lastMessage: string | null = null
    let messageCount = 0

    try {
      await scanJsonlFile(filePath, (line) => {
        messageCount += 1
        try {
          const evt = JSON.parse(line)
          if (typeof evt?.content === 'string' && evt.content.trim()) {
            lastMessage = truncate(evt.content)
          }
        } catch {
          // ignore malformed line
        }
      })
    } catch {
      // ignore unreadable transcript
    }

    return {
      id: `claude:${filePath}`,
      source: 'claude' as const,
      scope: pathScope(workspacePath, null, 'user'),
      tileId: null,
      sessionId: basename(filePath, '.jsonl'),
      provider: 'claude',
      model: '',
      messageCount,
      lastMessage,
      updatedAt: stat?.mtimeMs ?? 0,
      filePath,
      title: sessionTitleFromText('Claude session', lastMessage),
      projectPath: null,
      sourceLabel: 'Claude',
      sourceDetail: 'Transcript',
      canOpenInChat: true,
      canOpenInApp: true,
      resumeBin: 'claude',
      resumeArgs: ['--resume', basename(filePath, '.jsonl')],
    }
  }))

  return entries
}

function parseCodexTimestamp(filePath: string): number {
  const base = basename(filePath)
  const match = base.match(/rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/)
  if (!match) return 0
  const [, y, m, d, hh, mm, ss] = match
  return Date.parse(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`) || 0
}

async function listCodexSessions(workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const root = join(homedir(), '.codex', 'sessions')
  if (!(await fileExists(root))) return []

  const files = await listFilesRecursive(root, path => {
    const ext = extname(path).toLowerCase()
    return ext === '.jsonl' || ext === '.json'
  }, 4)

  const recent = files
    .map(filePath => ({ filePath, ts: parseCodexTimestamp(filePath) }))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 80)

  const entries = await Promise.all(recent.map(async ({ filePath, ts }) => {
    let lastMessage: string | null = null
    let messageCount = 0
    let projectPath: string | null = null
    let model = ''
    let sessionId: string | null = basename(filePath, extname(filePath))

    try {
      await scanJsonlFile(filePath, (line) => {
        try {
          const evt = JSON.parse(line)
          if (!projectPath && typeof evt?.payload?.cwd === 'string') projectPath = evt.payload.cwd
          if (!model && typeof evt?.payload?.model === 'string') model = evt.payload.model
          if (!sessionId && typeof evt?.payload?.id === 'string') sessionId = evt.payload.id
          if (evt?.type === 'response_item' && evt?.payload?.type === 'message') {
            const text = truncate(extractTextParts(evt.payload.content))
            if (text) {
              messageCount += 1
              lastMessage = text
            }
          }
        } catch {
          // ignore malformed line
        }
      })
    } catch {
      // ignore unreadable file
    }

    return {
      id: `codex:${filePath}`,
      source: 'codex' as const,
      scope: pathScope(workspacePath, projectPath, 'user'),
      tileId: null,
      sessionId,
      provider: 'codex',
      model,
      messageCount,
      lastMessage,
      updatedAt: ts,
      filePath,
      title: sessionTitleFromText('Codex session', lastMessage),
      projectPath,
      sourceLabel: 'Codex',
      sourceDetail: model || 'CLI session',
      canOpenInChat: true,
      canOpenInApp: true,
      resumeBin: 'codex',
      resumeArgs: sessionId ? ['resume', sessionId] : ['resume'],
    }
  }))

  return entries
}

function decodeCursorMeta(hex: string): Record<string, any> | null {
  try {
    return JSON.parse(Buffer.from(hex.trim(), 'hex').toString('utf8'))
  } catch {
    return null
  }
}

async function listCursorSessions(_workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const root = join(homedir(), '.cursor', 'chats')
  if (!(await fileExists(root))) return []

  const dbFiles = await listFilesRecursive(root, path => basename(path) === 'store.db', 3)
  const withStat = await Promise.all(dbFiles.map(async filePath => ({ filePath, stat: await statSafe(filePath) })))
  const recent = withStat
    .filter(item => item.stat?.isFile())
    .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0))
    .slice(0, 60)

  return recent.map(({ filePath, stat }) => {
    let title = 'Cursor chat'
    let sessionId = basename(filePath)

    try {
      const db = new Database(filePath, { readonly: true })
      const row = db.prepare("select value from meta where key='0'").get() as { value?: string } | undefined
      const meta = row?.value ? decodeCursorMeta(row.value) : null
      if (typeof meta?.name === 'string' && meta.name.trim()) title = meta.name.trim()
      if (typeof meta?.agentId === 'string') sessionId = meta.agentId
      db.close()
    } catch {
      // ignore cursor db parse issues
    }

    return {
      id: `cursor:${filePath}`,
      source: 'cursor' as const,
      scope: 'user' as const,
      tileId: null,
      sessionId,
      provider: 'cursor',
      model: '',
      messageCount: 0,
      lastMessage: null,
      updatedAt: stat?.mtimeMs ?? 0,
      filePath,
      title,
      projectPath: null,
      sourceLabel: 'Cursor',
      sourceDetail: 'Local chat store',
      canOpenInChat: false,
      canOpenInApp: false,
    }
  })
}

async function listOpenClawSessions(workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const root = join(homedir(), '.openclaw', 'agents')
  if (!(await fileExists(root))) return []

  let agentDirs: Array<import('fs').Dirent> = []
  try {
    agentDirs = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const entries: AggregatedSessionEntry[] = []

  for (const dirent of agentDirs) {
    if (!dirent.isDirectory()) continue
    const agentId = dirent.name
    const sessionsIndexPath = join(root, agentId, 'sessions', 'sessions.json')
    const parsed = await readJsonSafe(sessionsIndexPath)
    if (!parsed || typeof parsed !== 'object') continue

    for (const [key, value] of Object.entries(parsed)) {
      const meta = value as any
      if (typeof meta?.deletedAt === 'number') continue
      const updatedAt = typeof meta?.updatedAt === 'number' ? meta.updatedAt : 0
      const sessionFile = typeof meta?.sessionFile === 'string' ? meta.sessionFile : undefined
      const label = formatOpenClawTitle(agentId, key, meta)
      entries.push({
        id: `openclaw:${agentId}:${key}`,
        source: 'openclaw',
        scope: pathScope(workspacePath, null, 'user'),
        tileId: null,
        sessionId: typeof meta?.sessionId === 'string' ? meta.sessionId : null,
        provider: 'openclaw',
        model: agentId,
        messageCount: 0,
        lastMessage: null,
        updatedAt,
        filePath: sessionFile,
        title: label.title,
        projectPath: null,
        sourceLabel: 'OpenClaw',
        sourceDetail: label.detail,
        canOpenInChat: Boolean(sessionFile),
        canOpenInApp: true,
        resumeBin: 'openclaw',
        resumeArgs: ['tui', '--session', key],
        relatedGroupId: label.relatedGroupId,
        nestingLevel: label.nestingLevel,
      })
    }
  }

  return entries.sort(compareSessions).slice(0, 80)
}

function parseOpenCodeTimestamp(filePath: string): number {
  const base = basename(filePath)
  const match = base.match(/_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/)
  if (!match) return 0
  const [, date, hh, mm, ss, ms] = match
  return Date.parse(`${date}T${hh}:${mm}:${ss}.${ms}Z`) || 0
}

async function listOpenCodeSessions(workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const root = join(homedir(), '.opencode', 'conversations')
  if (!(await fileExists(root))) return []

  const files = await listFilesRecursive(root, path => extname(path).toLowerCase() === '.json', 3)
  const recent = files
    .map(filePath => ({ filePath, ts: parseOpenCodeTimestamp(filePath) }))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 80)

  const entries = await Promise.all(recent.map(async ({ filePath, ts }) => {
    const parsed = await readJsonSafe(filePath, { maxBytes: MAX_SESSION_LISTING_JSON_BYTES })
    const projectPath = typeof parsed?.projectPath === 'string' ? parsed.projectPath : null
    const lastMessage = Array.isArray(parsed?.messages)
      ? truncate(parsed.messages.filter((m: any) => typeof m?.content === 'string' && m.role !== 'system').slice(-1)[0]?.content)
      : null
    const sessionId = typeof parsed?.id === 'string' ? parsed.id : basename(filePath, '.json')

    return {
      id: `opencode:${filePath}`,
      source: 'opencode' as const,
      scope: pathScope(workspacePath, projectPath, 'user'),
      tileId: null,
      sessionId,
      provider: 'opencode',
      model: typeof parsed?.model === 'string' ? parsed.model : '',
      messageCount: Array.isArray(parsed?.messages) ? parsed.messages.length : 0,
      lastMessage,
      updatedAt: ts || Date.parse(parsed?.startTime ?? '') || 0,
      filePath,
      title: sessionTitleFromText('OpenCode session', lastMessage),
      projectPath,
      sourceLabel: 'OpenCode',
      sourceDetail: typeof parsed?.model === 'string' ? parsed.model : 'Conversation',
      canOpenInChat: true,
      canOpenInApp: true,
      resumeBin: 'opencode',
      resumeArgs: sessionId ? ['--session', sessionId] : [],
    }
  }))

  return entries
}

export async function listExternalSessionEntries(
  workspacePath: string | null,
  options?: { force?: boolean },
): Promise<AggregatedSessionEntry[]> {
  const cacheKey = workspacePath ?? '__no_workspace__'
  const cached = externalSessionCache.get(cacheKey)
  if (!options?.force && cached && (Date.now() - cached.at) < EXTERNAL_SESSION_CACHE_MS) {
    return cached.entries
  }

  await ensureCodeSurfStructure(workspacePath)

  const entries = [
    ...(await listCodeSurfSessionFiles(workspacePath)),
    ...(await listClaudeSessions(workspacePath)),
    ...(await listCodexSessions(workspacePath)),
    ...(await listCursorSessions(workspacePath)),
    ...(await listOpenClawSessions(workspacePath)),
    ...(await listOpenCodeSessions(workspacePath)),
  ].sort(compareSessions)

  externalSessionCache.set(cacheKey, { at: Date.now(), entries })
  return entries
}

export async function findSessionEntryById(workspacePath: string | null, id: string): Promise<AggregatedSessionEntry | null> {
  const entries = await listExternalSessionEntries(workspacePath)
  return entries.find(entry => entry.id === id) ?? null
}

async function parseCodeSurfChatState(filePath: string): Promise<ImportedChatState | null> {
  const parsed = await readJsonSafe(filePath)
  if (parsed && Array.isArray(parsed.messages)) {
    const messages = parsed.messages
      .map((message: any, index: number) => {
        const role = roleFromUnknown(message?.role) ?? 'assistant'
        return makeImportedRichMessage({
          id: `codesurf-${index}`,
          role,
          content: typeof message?.content === 'string' ? message.content : extractTextParts(message?.content),
          timestamp: Number(message?.timestamp) || Date.now() + index,
          thinking: typeof message?.thinking?.content === 'string'
            ? { content: message.thinking.content, done: message.thinking.done !== false }
            : undefined,
          toolBlocks: Array.isArray(message?.toolBlocks) ? message.toolBlocks : undefined,
        })
      })
      .filter(Boolean) as ImportedChatMessage[]

    return {
      provider: typeof parsed.provider === 'string' ? parsed.provider : 'claude',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      messages,
    }
  }

  const raw = await readTextSafe(filePath)
  if (!raw) return null
  return {
    provider: 'claude',
    model: '',
    sessionId: null,
    messages: [
      {
        id: 'codesurf-import-0',
        role: 'system',
        content: raw,
        timestamp: Date.now(),
      },
    ],
  }
}

async function parseClaudeChatState(filePath: string, entry: AggregatedSessionEntry): Promise<ImportedChatState | null> {
  const raw = await readTextSafe(filePath)
  if (!raw) return null
  const messages = raw.split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        const evt = JSON.parse(line)
        const role = roleFromUnknown(evt?.type) ?? roleFromUnknown(evt?.role)
        if (!role || typeof evt?.content !== 'string') return null
        return makeImportedMessage(`claude-${index}`, role, evt.content, Date.parse(evt?.timestamp ?? '') || Date.now() + index)
      } catch {
        return null
      }
    })
    .filter(Boolean) as ImportedChatMessage[]

  return {
    provider: 'claude',
    model: entry.model,
    sessionId: entry.sessionId,
    messages,
  }
}

async function parseCodexChatState(filePath: string, entry: AggregatedSessionEntry): Promise<ImportedChatState | null> {
  const raw = await readTextSafe(filePath)
  if (!raw) return null
  const messages: ImportedChatMessage[] = []
  const pendingToolCalls = new Map<string, PendingImportedToolCall>()
  let pendingThinking: string[] = []
  let pendingCalls: PendingImportedToolCall[] = []

  const flushAssistantArtifacts = (index: number, timestamp: number, content = '') => {
    const next = makeImportedRichMessage({
      id: `codex-${index}`,
      role: 'assistant',
      content,
      timestamp,
      thinking: pendingThinking.length > 0 ? { content: pendingThinking.join('\n\n'), done: true } : undefined,
      toolBlocks: buildImportedToolBlocks(pendingCalls),
    })
    if (next) messages.push(next)
    pendingThinking = []
    pendingCalls = []
    pendingToolCalls.clear()
  }

  const lines = raw.split(/\r?\n/).filter(Boolean)
  lines.forEach((line, index) => {
    try {
      const evt = JSON.parse(line)
      const timestamp = Date.parse(evt?.timestamp ?? '') || Date.now() + index

      if (evt?.type !== 'response_item') return
      const payload = evt?.payload

      if (payload?.type === 'reasoning') {
        const summary = extractReasoningSummary(payload)
        if (summary) pendingThinking.push(summary)
        return
      }

      if (payload?.type === 'function_call' || payload?.type === 'custom_tool_call') {
        const call = parseCodexToolCall(payload)
        if (!call) return
        pendingToolCalls.set(call.id, call)
        pendingCalls.push(call)
        return
      }

      if (payload?.type === 'function_call_output') {
        const callId = typeof payload?.call_id === 'string' ? payload.call_id : null
        if (!callId) return
        const existing = pendingToolCalls.get(callId)
        if (!existing) return
        existing.output = sanitizeToolOutputText(typeof payload?.output === 'string' ? payload.output : '')
        if (existing.commandEntry) existing.commandEntry.output = existing.output
        return
      }

      if (payload?.type !== 'message') return
      const role = roleFromUnknown(payload?.role)
      if (!role) return

      const content = extractTextParts(payload.content)
      if (role === 'assistant') {
        flushAssistantArtifacts(index, timestamp, content)
        return
      }

      if (pendingThinking.length > 0 || pendingCalls.length > 0) {
        flushAssistantArtifacts(index, timestamp, '')
      }

      const message = makeImportedMessage(`codex-${index}`, role, content, timestamp)
      if (message) messages.push(message)
    } catch {
      // ignore malformed session lines
    }
  })

  if (pendingThinking.length > 0 || pendingCalls.length > 0) {
    flushAssistantArtifacts(lines.length, Date.now())
  }

  return {
    provider: 'codex',
    model: entry.model,
    sessionId: entry.sessionId,
    messages,
  }
}

async function parseOpenClawChatState(filePath: string, entry: AggregatedSessionEntry): Promise<ImportedChatState | null> {
  const raw = await readTextSafe(filePath)
  if (!raw) return null
  const messages = raw.split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        const evt = JSON.parse(line)
        if (evt?.type !== 'message') return null
        const role = roleFromUnknown(evt?.message?.role)
        if (!role) return null
        return makeImportedMessage(`openclaw-${index}`, role, extractTextParts(evt?.message?.content), Date.parse(evt?.timestamp ?? '') || Number(evt?.message?.timestamp) || Date.now() + index)
      } catch {
        return null
      }
    })
    .filter(Boolean) as ImportedChatMessage[]

  return {
    provider: 'openclaw',
    model: entry.model,
    sessionId: entry.sessionId,
    messages,
  }
}

async function parseOpenCodeChatState(filePath: string, entry: AggregatedSessionEntry): Promise<ImportedChatState | null> {
  const parsed = await readJsonSafe(filePath)
  if (!parsed || !Array.isArray(parsed.messages)) return null
  const messages = parsed.messages
    .map((message: any, index: number) => {
      const role = roleFromUnknown(message?.role)
      if (!role) return null
      return makeImportedMessage(`opencode-${index}`, role, extractTextParts(message?.content), Number(message?.timestamp) || Date.now() + index)
    })
    .filter(Boolean) as ImportedChatMessage[]

  return {
    provider: 'opencode',
    model: entry.model,
    sessionId: entry.sessionId,
    messages,
  }
}

export function invalidateExternalSessionCache(workspacePath?: string | null): void {
  if (workspacePath) {
    externalSessionCache.delete(workspacePath)
    return
  }
  externalSessionCache.clear()
}

export async function getExternalSessionChatState(workspacePath: string | null, id: string): Promise<ImportedChatState | null> {
  const entry = await findSessionEntryById(workspacePath, id)
  if (!entry?.filePath || !entry.canOpenInChat) return null

  if (entry.source === 'codesurf') return parseCodeSurfChatState(entry.filePath)
  if (entry.source === 'claude') return parseClaudeChatState(entry.filePath, entry)
  if (entry.source === 'codex') return parseCodexChatState(entry.filePath, entry)
  if (entry.source === 'openclaw') return parseOpenClawChatState(entry.filePath, entry)
  if (entry.source === 'opencode') return parseOpenCodeChatState(entry.filePath, entry)
  return null
}

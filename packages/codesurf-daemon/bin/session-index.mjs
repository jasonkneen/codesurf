import { createReadStream, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { createInterface } from 'node:readline'
import Database from 'better-sqlite3'

const STANDARD_CODESURF_SUBDIRS = ['sessions', 'agents', 'skills', 'tools', 'plugins', 'extensions']
const EXTERNAL_SESSION_CACHE_MS = 30_000
const EXTERNAL_SESSION_STATE_CACHE_MAX_ENTRIES = 64
const LARGE_EXTERNAL_SESSION_BYTES = 6 * 1024 * 1024
const EXTERNAL_SESSION_HEAD_SAMPLE_BYTES = 128 * 1024
const EXTERNAL_SESSION_TAIL_SAMPLE_BYTES = 4 * 1024 * 1024
const MAX_SESSION_LISTING_JSON_BYTES = 2 * 1024 * 1024
const MAX_SESSION_LISTING_TEXT_SAMPLE_BYTES = 16 * 1024
const GENERIC_OPENCLAW_LABELS = new Set(['openclaw studio', 'openclawstudio', 'openclaw-tui', 'vibeclaw', 'heartbeat'])

const externalSessionCache = new Map()
const externalSessionStateCache = new Map()
const SESSION_TITLE_OVERRIDES_FILE = 'session-title-overrides.json'

function getProjectCodeSurfDir(codesurfHome, workspacePath) {
  return join(workspacePath, '.codesurf')
}

async function ensureDir(path) {
  await fs.mkdir(path, { recursive: true })
}

async function readSessionTitleOverrides(codesurfHome) {
  try {
    const raw = await fs.readFile(join(codesurfHome, SESSION_TITLE_OVERRIDES_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function normalizePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
}

function externalSessionOverrideKey(workspacePath, id) {
  return `external:${normalizePath(workspacePath) || '__global__'}:${String(id ?? '').trim()}`
}

async function applyExternalSessionTitleOverrides(codesurfHome, workspacePath, entries) {
  const overrides = await readSessionTitleOverrides(codesurfHome)
  return entries.map(entry => {
    const override = overrides[externalSessionOverrideKey(workspacePath, entry.id)]
    if (typeof override !== 'string' || !override.trim()) return entry
    return { ...entry, title: override.trim() }
  })
}

export async function ensureCodeSurfStructure(codesurfHome, workspacePath) {
  await ensureDir(codesurfHome)
  await Promise.all(STANDARD_CODESURF_SUBDIRS.map(dir => ensureDir(join(codesurfHome, dir))))

  if (!workspacePath) return
  const projectDir = getProjectCodeSurfDir(codesurfHome, workspacePath)
  await ensureDir(projectDir)
  await Promise.all(STANDARD_CODESURF_SUBDIRS.map(dir => ensureDir(join(projectDir, dir))))
}

async function fileExists(path) {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function readJsonSafe(path, options) {
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

async function readTextSafe(path) {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function readTextPreviewSafe(path, maxBytes = MAX_SESSION_LISTING_TEXT_SAMPLE_BYTES) {
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

async function readTextTailSafe(path, maxBytes) {
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

async function statSafe(path) {
  try {
    return await fs.stat(path)
  } catch {
    return null
  }
}

function touchExternalSessionStateCache(key, value) {
  externalSessionStateCache.delete(key)
  externalSessionStateCache.set(key, value)
  while (externalSessionStateCache.size > EXTERNAL_SESSION_STATE_CACHE_MAX_ENTRIES) {
    const oldestKey = externalSessionStateCache.keys().next().value
    if (!oldestKey) break
    externalSessionStateCache.delete(oldestKey)
  }
  return value.state
}

async function getCachedExternalSessionChatState(cacheKey, filePath, load) {
  const stat = await statSafe(filePath)
  if (!stat?.isFile()) {
    externalSessionStateCache.delete(cacheKey)
    return null
  }

  const cached = externalSessionStateCache.get(cacheKey)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return touchExternalSessionStateCache(cacheKey, cached)
  }

  const state = await load()
  return touchExternalSessionStateCache(cacheKey, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    state,
  })
}

async function scanJsonlFile(filePath, onLine) {
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

function truncate(text, length = 120) {
  if (!text) return null
  const normalized = String(text).replace(/\s+/g, ' ').trim()
  return normalized.length > length ? normalized.slice(0, length) : normalized
}

function isSessionTitleBoilerplateLine(line) {
  const normalized = String(line ?? '').trim()
  if (!normalized) return true
  return /^(?:#\s*)?AGENTS\.md instructions for\b/i.test(normalized)
    || /^(?:#\s*)?CLAUDE\.md instructions for\b/i.test(normalized)
    || /^<INSTRUCTIONS>$/i.test(normalized)
    || /^<\/INSTRUCTIONS>$/i.test(normalized)
    || /^---\s*project-doc\s*---$/i.test(normalized)
    || /^#+\s*(?:Non-Negotiable Rules|GSDN Native Mode|Installed GSDN assets|Usage rules|Skills|Files mentioned by the user)\b/i.test(normalized)
    || /^Launching skill:/i.test(normalized)
    || /^Base directory for this skill:/i.test(normalized)
    || /^The `?\.codesurf\/DREAMING\.md`? has been written/i.test(normalized)
}

function firstMeaningfulSessionTitleLine(text) {
  const source = String(text ?? '').replace(/\r\n/g, '\n').trim()
  if (!source) return null

  const explicitRequest = source.match(/#+\s*My request for Codex:\s*([\s\S]+)/i)
  if (explicitRequest?.[1]?.trim()) return firstMeaningfulSessionTitleLine(explicitRequest[1])

  let insideInstructions = false
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
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

function sessionTitleFromText(fallback, text) {
  const trimmed = firstMeaningfulSessionTitleLine(text) ?? text?.trim()
  if (!trimmed) return fallback
  return trimmed.split(/\r?\n/, 1)[0].slice(0, 80)
}

function pathScope(workspacePath, sessionProjectPath, fallback = 'user') {
  if (workspacePath && sessionProjectPath && workspacePath === sessionProjectPath) return 'project'
  return fallback
}

function compareSessions(a, b) {
  return b.updatedAt - a.updatedAt
}

function humanizeSlug(value) {
  return String(value ?? '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase())
}

function isGenericOpenClawLabel(value) {
  if (!value) return true
  return GENERIC_OPENCLAW_LABELS.has(value.trim().toLowerCase())
}

function stripCodexSystemMarkers(text) {
  if (!text) return text
  return text.replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/g, '').trim()
}

function extractTextParts(content) {
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
    if (typeof content.text === 'string') return content.text
    if (typeof content.content === 'string') return content.content
    if (typeof content.value === 'string') return content.value
  }
  return ''
}

function makeTranscriptTruncationMessage(provider, fileSizeBytes) {
  const sizeMb = Math.max(1, Math.round(fileSizeBytes / (1024 * 1024)))
  const label = provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : 'CLI'
  return {
    id: `${provider}-truncated-notice`,
    role: 'system',
    content: `${label} transcript trimmed for faster loading. Showing the start of the conversation and recent activity from a ${sizeMb} MB session.`,
    timestamp: Date.now(),
  }
}

function dedupeImportedMessages(messages) {
  const out = []
  const seen = new Set()
  for (const message of messages) {
    const key = `${message.role}::${message.timestamp}::${message.content}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(message)
  }
  return out
}

function parseJsonlLines(raw) {
  return String(raw ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
}

function parseClaudeLine(line, index) {
  try {
    const evt = JSON.parse(line)
    const role = roleFromUnknown(evt?.type) ?? roleFromUnknown(evt?.role)
    if (!role || typeof evt?.content !== 'string') return null
    return makeImportedMessage(
      `claude-${index}`,
      role,
      evt.content,
      Date.parse(evt?.timestamp ?? '') || Date.now() + index,
    )
  } catch {
    return null
  }
}

function parseClaudeMessagesFromLines(lines, offset = 0) {
  return lines
    .map((line, index) => parseClaudeLine(line, offset + index))
    .filter(Boolean)
}

function roleFromUnknown(value) {
  return value === 'user' || value === 'assistant' || value === 'system' ? value : null
}

function makeImportedMessage(id, role, content, timestamp) {
  const trimmed = String(content ?? '').trim()
  if (!trimmed) return null
  return { id, role, content: trimmed, timestamp }
}

function makeImportedRichMessage(params) {
  const trimmedContent = String(params.content ?? '').trim()
  const toolBlocks = (Array.isArray(params.toolBlocks) ? params.toolBlocks : []).filter(block => {
    return Boolean(String(block?.name ?? '').trim())
      && (
        Boolean(String(block?.input ?? '').trim())
        || Boolean(String(block?.summary ?? '').trim())
        || ((block?.fileChanges?.length ?? 0) > 0)
        || ((block?.commandEntries?.length ?? 0) > 0)
      )
  })
  const thinking = params.thinking && String(params.thinking.content ?? '').trim()
    ? { ...params.thinking, content: String(params.thinking.content).trim() }
    : undefined

  if (!trimmedContent && !thinking && toolBlocks.length === 0) return null

  const contentBlocks = []
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

function truncateToolPreview(text, length = 800) {
  if (!text) return ''
  return text.length > length ? `${text.slice(0, length)}\n…` : text
}

function sanitizeToolOutputText(text) {
  if (!text) return ''

  return String(text)
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

function extractReasoningSummary(payload) {
  if (!Array.isArray(payload?.summary)) return ''
  return payload.summary
    .map(entry => typeof entry?.text === 'string' ? entry.text.trim() : '')
    .filter(Boolean)
    .join('\n\n')
}

function parseJsonObject(raw) {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function extractCommandFromToolCall(name, rawInput) {
  const parsed = parseJsonObject(rawInput)
  if (name === 'exec_command') return typeof parsed?.cmd === 'string' ? parsed.cmd : rawInput
  if (name === 'shell_command') return typeof parsed?.command === 'string' ? parsed.command : rawInput
  if (name === 'shell') {
    if (Array.isArray(parsed?.command)) return parsed.command.map(part => String(part)).join(' ')
    if (typeof parsed?.command === 'string') return parsed.command
  }
  return rawInput
}

function extractApplyPatchText(rawInput) {
  const beginIndex = rawInput.indexOf('*** Begin Patch')
  const endIndex = rawInput.lastIndexOf('*** End Patch')
  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) return null
  return rawInput.slice(beginIndex, endIndex + '*** End Patch'.length)
}

function parseApplyPatchFileChanges(patchText) {
  const lines = patchText.replace(/\r\n/g, '\n').split('\n')
  const changes = []
  let current = null

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

function classifyCommand(command) {
  const normalized = command.trim()
  if (/(^|\s)(rg|grep|fd|findstr)\b/.test(normalized)) return 'search'
  if (/(^|\s)(cat|sed|head|tail|less|more|bat)\b/.test(normalized)) return 'read'
  if (/(^|\s)ls\b/.test(normalized)) return 'read'
  return 'command'
}

function buildImportedToolBlocks(calls) {
  const blocks = []
  const handledIds = new Set()

  const fileChangeMap = new Map()
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
    .map(call => call.commandEntry)

  if (exploreEntries.length > 0) {
    const readCount = exploreEntries.filter(entry => entry.kind === 'read').length
    const searchCount = exploreEntries.filter(entry => entry.kind === 'search').length
    const labelParts = []
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

function parseCodexToolCall(payload) {
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

async function listFilesRecursive(root, predicate, maxDepth = 4) {
  const out = []

  async function walk(dir, depth) {
    if (depth > maxDepth) return
    let entries = []
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

function decodeCursorMeta(hex) {
  try {
    return JSON.parse(Buffer.from(hex.trim(), 'hex').toString('utf8'))
  } catch {
    return null
  }
}

function parseOpenClawKey(sessionKey) {
  const parts = String(sessionKey ?? '').split(':')
  const agentId = parts[1] || 'main'
  const route = parts[2] || 'main'
  return {
    agentId,
    route,
    groupId: `openclaw:${agentId}`,
    isSubagent: route === 'subagent',
  }
}

function formatOpenClawTitle(agentId, sessionKey, meta) {
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

function parseCodexTimestamp(filePath) {
  const base = basename(filePath)
  const match = base.match(/rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/)
  if (!match) return 0
  const [, y, m, d, hh, mm, ss] = match
  return Date.parse(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`) || 0
}

function parseOpenCodeTimestamp(filePath) {
  const base = basename(filePath)
  const match = base.match(/_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/)
  if (!match) return 0
  const [, date, hh, mm, ss, ms] = match
  return Date.parse(`${date}T${hh}:${mm}:${ss}.${ms}Z`) || 0
}

async function listCodeSurfSessionFiles(codesurfHome, workspacePath) {
  const roots = []
  if (workspacePath) roots.push({ dir: join(getProjectCodeSurfDir(codesurfHome, workspacePath), 'sessions'), scope: 'project' })
  roots.push({ dir: join(codesurfHome, 'sessions'), scope: 'user' })

  const entries = []

  for (const root of roots) {
    if (!(await fileExists(root.dir))) continue
    const files = await listFilesRecursive(root.dir, path => ['.json', '.jsonl', '.md', '.txt'].includes(extname(path).toLowerCase()), 3)

    for (const filePath of files) {
      const stat = await statSafe(filePath)
      if (!stat?.isFile()) continue

      let title = basename(filePath)
      let lastMessage = null
      let messageCount = 0
      let sessionId = basename(filePath, extname(filePath))
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

async function listClaudeSessions(workspacePath) {
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

  return await Promise.all(recent.map(async ({ filePath, stat }) => {
    let lastMessage = null
    let messageCount = 0

    try {
      await scanJsonlFile(filePath, line => {
        messageCount += 1
        try {
          const evt = JSON.parse(line)
          if (typeof evt?.content === 'string' && evt.content.trim()) {
            lastMessage = truncate(evt.content)
          }
        } catch {}
      })
    } catch {}

    return {
      id: `claude:${filePath}`,
      source: 'claude',
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
}

async function listCodexSessions(workspacePath) {
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

  return await Promise.all(recent.map(async ({ filePath, ts }) => {
    let lastMessage = null
    let messageCount = 0
    let projectPath = null
    let model = ''
    let sessionId = basename(filePath, extname(filePath))

    try {
      await scanJsonlFile(filePath, line => {
        try {
          const evt = JSON.parse(line)
          if (!projectPath && typeof evt?.payload?.cwd === 'string') projectPath = evt.payload.cwd
          if (!model && typeof evt?.payload?.model === 'string') model = evt.payload.model
          if (!sessionId && typeof evt?.payload?.id === 'string') sessionId = evt.payload.id
          if (evt?.type === 'response_item' && evt?.payload?.type === 'message') {
            const text = truncate(stripCodexSystemMarkers(extractTextParts(evt.payload.content)))
            if (text) {
              messageCount += 1
              lastMessage = text
            }
          }
        } catch {}
      })
    } catch {}

    return {
      id: `codex:${filePath}`,
      source: 'codex',
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
}

async function listCursorSessions() {
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
      const row = db.prepare("select value from meta where key='0'").get()
      const meta = row?.value ? decodeCursorMeta(row.value) : null
      if (typeof meta?.name === 'string' && meta.name.trim()) title = meta.name.trim()
      if (typeof meta?.agentId === 'string') sessionId = meta.agentId
      db.close()
    } catch {}

    return {
      id: `cursor:${filePath}`,
      source: 'cursor',
      scope: 'user',
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

async function listOpenClawSessions(workspacePath) {
  const root = join(homedir(), '.openclaw', 'agents')
  if (!(await fileExists(root))) return []

  let agentDirs = []
  try {
    agentDirs = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const entries = []

  for (const dirent of agentDirs) {
    if (!dirent.isDirectory()) continue
    const agentId = dirent.name
    const sessionsIndexPath = join(root, agentId, 'sessions', 'sessions.json')
    const parsed = await readJsonSafe(sessionsIndexPath)
    if (!parsed || typeof parsed !== 'object') continue

    for (const [key, value] of Object.entries(parsed)) {
      const meta = value
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

async function listOpenCodeSessions(workspacePath) {
  const root = join(homedir(), '.opencode', 'conversations')
  if (!(await fileExists(root))) return []

  const files = await listFilesRecursive(root, path => extname(path).toLowerCase() === '.json', 3)
  const recent = files
    .map(filePath => ({ filePath, ts: parseOpenCodeTimestamp(filePath) }))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 80)

  return await Promise.all(recent.map(async ({ filePath, ts }) => {
    const parsed = await readJsonSafe(filePath, { maxBytes: MAX_SESSION_LISTING_JSON_BYTES })
    const projectPath = typeof parsed?.projectPath === 'string' ? parsed.projectPath : null
    const lastMessage = Array.isArray(parsed?.messages)
      ? truncate(parsed.messages.filter(m => typeof m?.content === 'string' && m.role !== 'system').slice(-1)[0]?.content)
      : null
    const sessionId = typeof parsed?.id === 'string' ? parsed.id : basename(filePath, '.json')

    return {
      id: `opencode:${filePath}`,
      source: 'opencode',
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
}

export async function listExternalSessionEntries(codesurfHome, workspacePath, options) {
  const cacheKey = workspacePath ?? '__no_workspace__'
  const cached = externalSessionCache.get(cacheKey)
  if (!options?.force && cached && (Date.now() - cached.at) < EXTERNAL_SESSION_CACHE_MS) {
    return cached.entries
  }

  await ensureCodeSurfStructure(codesurfHome, workspacePath)

  const entries = [
    ...(await listCodeSurfSessionFiles(codesurfHome, workspacePath)),
    ...(await listClaudeSessions(workspacePath)),
    ...(await listCodexSessions(workspacePath)),
    ...(await listCursorSessions(workspacePath)),
    ...(await listOpenClawSessions(workspacePath)),
    ...(await listOpenCodeSessions(workspacePath)),
  ].sort(compareSessions)
  const overriddenEntries = await applyExternalSessionTitleOverrides(codesurfHome, workspacePath, entries)

  externalSessionCache.set(cacheKey, { at: Date.now(), entries: overriddenEntries })
  return overriddenEntries
}

export async function findSessionEntryById(codesurfHome, workspacePath, id) {
  const scoped = await listExternalSessionEntries(codesurfHome, workspacePath)
  const scopedHit = scoped.find(entry => entry.id === id)
  if (scopedHit) return scopedHit

  if (workspacePath) {
    const global = await listExternalSessionEntries(codesurfHome, null)
    const globalHit = global.find(entry => entry.id === id)
    if (globalHit) return globalHit
  }

  const refreshed = await listExternalSessionEntries(codesurfHome, workspacePath, { force: true })
  return refreshed.find(entry => entry.id === id) ?? null
}

async function parseCodeSurfChatState(filePath) {
  const parsed = await readJsonSafe(filePath)
  if (parsed && Array.isArray(parsed.messages)) {
    const messages = parsed.messages
      .map((message, index) => {
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
      .filter(Boolean)

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

async function parseClaudeChatState(filePath, entry) {
  const stat = await statSafe(filePath)
  if (!stat?.isFile()) return null

  if (stat.size > LARGE_EXTERNAL_SESSION_BYTES) {
    const [headRaw, tailRaw] = await Promise.all([
      readTextPreviewSafe(filePath, EXTERNAL_SESSION_HEAD_SAMPLE_BYTES),
      readTextTailSafe(filePath, EXTERNAL_SESSION_TAIL_SAMPLE_BYTES),
    ])

    const headMessages = parseClaudeMessagesFromLines(parseJsonlLines(headRaw), 0)
    const tailLines = parseJsonlLines(tailRaw)
    const tailMessages = parseClaudeMessagesFromLines(tailLines, 0)
    const firstMessage = headMessages.find(message => message.role !== 'system') ?? headMessages[0] ?? null
    const messages = dedupeImportedMessages([
      ...(firstMessage ? [firstMessage] : []),
      makeTranscriptTruncationMessage('claude', stat.size),
      ...tailMessages,
    ])

    return {
      provider: 'claude',
      model: entry.model,
      sessionId: entry.sessionId,
      messages,
    }
  }

  const messages = []

  try {
    await scanJsonlFile(filePath, (line, lineNumber) => {
      try {
        const evt = JSON.parse(line)
        const role = roleFromUnknown(evt?.type) ?? roleFromUnknown(evt?.role)
        if (!role || typeof evt?.content !== 'string') return
        const message = makeImportedMessage(
          `claude-${lineNumber - 1}`,
          role,
          evt.content,
          Date.parse(evt?.timestamp ?? '') || Date.now() + lineNumber,
        )
        if (message) messages.push(message)
      } catch {}
    })
  } catch {
    return null
  }

  return {
    provider: 'claude',
    model: entry.model,
    sessionId: entry.sessionId,
    messages,
  }
}

function parseCodexChatStateFromLines(lines, entry, offset = 0) {
  const messages = []
  const pendingToolCalls = new Map()
  let pendingThinking = []
  let pendingCalls = []
  let model = entry.model
  let sessionId = entry.sessionId

  const flushAssistantArtifacts = (index, timestamp, content = '') => {
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

  let lastIndex = offset
  lines.forEach((line, index) => {
    const absoluteIndex = offset + index
    lastIndex = absoluteIndex
    try {
      const evt = JSON.parse(line)
      const timestamp = Date.parse(evt?.timestamp ?? '') || Date.now() + absoluteIndex
      const payload = evt?.payload

      if (!model && typeof payload?.model === 'string') model = payload.model
      if (!sessionId && typeof payload?.id === 'string') sessionId = payload.id

      if (evt?.type !== 'response_item') return

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

      const content = stripCodexSystemMarkers(extractTextParts(payload.content))
      if (role === 'assistant') {
        flushAssistantArtifacts(absoluteIndex, timestamp, content)
        return
      }

      if (pendingThinking.length > 0 || pendingCalls.length > 0) {
        flushAssistantArtifacts(absoluteIndex, timestamp, '')
      }

      const message = makeImportedMessage(`codex-${absoluteIndex}`, role, content, timestamp)
      if (message) messages.push(message)
    } catch {}
  })

  if (pendingThinking.length > 0 || pendingCalls.length > 0) {
    flushAssistantArtifacts(lastIndex + 1, Date.now())
  }

  return {
    provider: 'codex',
    model,
    sessionId,
    messages,
  }
}

async function parseCodexChatState(filePath, entry) {
  const stat = await statSafe(filePath)
  if (!stat?.isFile()) return null

  if (stat.size > LARGE_EXTERNAL_SESSION_BYTES) {
    const [headRaw, tailRaw] = await Promise.all([
      readTextPreviewSafe(filePath, EXTERNAL_SESSION_HEAD_SAMPLE_BYTES),
      readTextTailSafe(filePath, EXTERNAL_SESSION_TAIL_SAMPLE_BYTES),
    ])
    const headLines = parseJsonlLines(headRaw)
    const tailLines = parseJsonlLines(tailRaw)
    const firstChunk = parseCodexChatStateFromLines(headLines, entry, 0)
    const recentChunk = parseCodexChatStateFromLines(tailLines, entry, Math.max(10_000, tailLines.length))
    const firstMessage = firstChunk.messages.find(message => message.role === 'user') ?? firstChunk.messages[0] ?? null
    const messages = dedupeImportedMessages([
      ...(firstMessage ? [firstMessage] : []),
      makeTranscriptTruncationMessage('codex', stat.size),
      ...recentChunk.messages,
    ])
    return {
      provider: 'codex',
      model: recentChunk.model || firstChunk.model,
      sessionId: recentChunk.sessionId ?? firstChunk.sessionId,
      messages,
    }
  }

  const lines = []
  try {
    await scanJsonlFile(filePath, line => {
      lines.push(line)
    })
  } catch {
    return null
  }
  return parseCodexChatStateFromLines(lines, entry, 0)
}

async function parseOpenClawChatState(filePath, entry) {
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
    .filter(Boolean)

  return {
    provider: 'openclaw',
    model: entry.model,
    sessionId: entry.sessionId,
    messages,
  }
}

async function parseOpenCodeChatState(filePath, entry) {
  const parsed = await readJsonSafe(filePath)
  if (!parsed || !Array.isArray(parsed.messages)) return null
  const messages = parsed.messages
    .map((message, index) => {
      const role = roleFromUnknown(message?.role)
      if (!role) return null
      return makeImportedMessage(`opencode-${index}`, role, extractTextParts(message?.content), Number(message?.timestamp) || Date.now() + index)
    })
    .filter(Boolean)

  return {
    provider: 'opencode',
    model: entry.model,
    sessionId: entry.sessionId,
    messages,
  }
}

export async function getExternalSessionChatState(codesurfHome, workspacePath, id) {
  const entry = await findSessionEntryById(codesurfHome, workspacePath, id)
  if (!entry?.filePath || !entry.canOpenInChat) return null
  const cacheKey = `${workspacePath ?? '__no_workspace__'}::${entry.source}::${entry.filePath}`

  return await getCachedExternalSessionChatState(cacheKey, entry.filePath, async () => {
    if (entry.source === 'codesurf') return parseCodeSurfChatState(entry.filePath)
    if (entry.source === 'claude') return parseClaudeChatState(entry.filePath, entry)
    if (entry.source === 'codex') return parseCodexChatState(entry.filePath, entry)
    if (entry.source === 'openclaw') return parseOpenClawChatState(entry.filePath, entry)
    if (entry.source === 'opencode') return parseOpenCodeChatState(entry.filePath, entry)
    return null
  })
}

export function invalidateExternalSessionCache(workspacePath) {
  if (workspacePath) {
    externalSessionCache.delete(workspacePath)
    for (const key of externalSessionStateCache.keys()) {
      if (key.startsWith(`${workspacePath}::`)) externalSessionStateCache.delete(key)
    }
    return
  }
  externalSessionCache.clear()
  externalSessionStateCache.clear()
}

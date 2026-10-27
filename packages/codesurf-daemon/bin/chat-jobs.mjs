import { query } from '@anthropic-ai/claude-agent-sdk'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  processTreeSpawnOptions,
  terminateProcessTree,
} from './process-tree.mjs'
import { StableContextAnnouncementCache, StableSessionContextCache } from './stable-session-context.mjs'
import { buildMemoryPrompt, loadMemoryContext } from './memory-loader.mjs'
import { buildContextBucketBundle, describeContextBucketsForTool } from './context-buckets.mjs'
import {
  MAX_SKILLS_SUMMARY_BYTES,
  previewContextToolInput,
  truncateUtf8,
} from './context-budget.mjs'
import { applyProjectContextPolicy } from './project-context.mjs'
import { buildPeerContextPrompt } from '../dist/peer-context-policy.js'
import { composeChatContext } from '../dist/context-composer.js'
import {
  buildCodeSurfActivityConvention,
  buildCodeSurfInsightConvention,
  buildCodeSurfOutputConvention,
} from '../dist/prompt-conventions.js'
import { PI_HARNESS_UNAVAILABLE_ERROR } from './harness-policy.mjs'
import {
  CODEX_SDK_UNAVAILABLE_CODE,
  buildCodexSdkThreadOptions,
  createCodexSdkClient,
  shouldUseCodexSdkProvider,
  startCodexSdkThread,
} from './codex-sdk-provider.mjs'
import {
  resolveAgentToolAllowList,
  codexSandboxApprovalFlags,
  hermesToolsetsFromAllowList,
  agentModeUnresolved,
  AGENT_MODE_UNRESOLVED_ERROR,
} from './agent-mode-tools.mjs'
import { resolveAuthoritativeAgentMode } from './agent-mode-resolver.mjs'
import {
  OMNIGENT_DEFAULT_BASE_URL,
  OMNIGENT_DEFAULT_CLI,
  buildOmnigentSessionBody,
  chooseOmnigentHost,
  decodeOmnigentModelId,
  extractOmnigentSessionId,
  mapOmnigentStreamEvent,
  normalizeOmnigentServerRoot,
  omnigentAuthHeaders,
  omnigentEndpointUrl,
  parseOmnigentHosts,
  parseOmnigentServerUrl,
  parseOmnigentSseChunk,
  parseOmnigentStatusJson,
} from './omnigent-provider.mjs'

const execFileAsync = promisify(execFile)

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true })
}

// The Claude Agent SDK persists each session's transcript at
//   <CLAUDE_CONFIG_DIR|~/.claude>/projects/<encoded-cwd>/<sessionId>.jsonl
// where <encoded-cwd> is the realpath-resolved cwd with every non-alphanumeric
// char replaced by '-' (long paths get a hash suffix). Resuming with a
// sessionId that has NO such transcript — e.g. a foreign codex/UUIDv7 thread id
// handed over after a provider switch, or a stale id — makes the SDK return
// num_turns:0 with zero assistant content, surfacing as an empty reply.
//
// Defense-in-depth guard: confirm the transcript belongs to this exact cwd
// before setting the SDK `resume` option. This mirrors the SDK project-key
// algorithm, avoiding a synchronous/unbounded scan of every historical project
// and preventing a same-id transcript from another workspace from being used.
function claudeProjectsDir() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(configDir, 'projects')
}

function claudeProjectKeyForResolvedCwd(resolvedCwd) {
  const normalized = resolvedCwd.normalize('NFC')
  const sanitized = normalized.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= 200) return sanitized
  let hash = 0
  for (let i = 0; i < normalized.length; i += 1) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0
  }
  return `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}

async function findClaudeResumeTranscript(sessionId, workspaceDir) {
  if (typeof sessionId !== 'string') return null
  const id = sessionId.trim()
  if (!id || typeof workspaceDir !== 'string' || !workspaceDir.trim()) return null
  // Reject anything that could escape the projects tree; real Claude session
  // ids are UUIDs and never contain path separators.
  if (id.includes('/') || id.includes('\\') || id.includes('..')) return null

  let resolvedCwd
  try {
    resolvedCwd = await fs.realpath(resolve(workspaceDir))
  } catch {
    resolvedCwd = resolve(workspaceDir)
  }
  const projectKey = claudeProjectKeyForResolvedCwd(resolvedCwd)
  const candidate = join(claudeProjectsDir(), projectKey, `${id}.jsonl`)
  try {
    return (await fs.stat(candidate)).size > 0 ? candidate : null
  } catch {
    return null
  }
}

let cachedClaudeExecutable = null

/**
 * Resolve the Claude Code executable passed to the agent SDK.
 *
 * The SDK otherwise resolves its own bundled native binary and throws
 * `Native CLI binary for <platform>-<arch> not found` whenever the optional
 * @anthropic-ai/claude-agent-sdk-<platform>-<arch> package is absent — pruned
 * installs, --omit=optional, a mid-flight npm install, or a packaged build that
 * dropped the 200MB binary. The Electron main process already passes an explicit
 * path (src/main/chat/providers/claude.ts); daemon jobs must do the same or they
 * fail with no fallback.
 */
export function resolveClaudeExecutable(homeDir) {
  if (cachedClaudeExecutable) return cachedClaudeExecutable
  const exeSuffix = process.platform === 'win32' ? '.exe' : ''
  const candidates = []
  try {
    const sdkEntry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')
    const platformPkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
    try {
      candidates.push(createRequire(sdkEntry).resolve(`${platformPkg}/claude${exeSuffix}`))
    } catch {}
    // Hoisted optional-dep sibling of sdk.mjs. createRequire can miss this
    // under Electron-as-node even when the 200MB binary is on disk.
    candidates.push(join(dirname(sdkEntry), '..', platformPkg, `claude${exeSuffix}`))
  } catch {}
  try {
    const raw = JSON.parse(readFileSync(join(homeDir, 'agent-paths.json'), 'utf8'))
    const configured = typeof raw?.claude?.path === 'string' ? raw.claude.path.trim() : ''
    if (configured) candidates.push(configured)
  } catch {}
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir) candidates.push(join(dir, `claude${exeSuffix}`))
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      cachedClaudeExecutable = candidate
      return candidate
    }
  }
  return null
}

/**
 * Text the assistant snapshot still owes the timeline after stream deltas.
 *
 * Stream events key by Claude content-block index (thinking=0, text=1, …).
 * The assembled `assistant` message often strips thinking, so text lands at
 * index 0. The old fallback then re-emitted the full snapshot as a new delta
 * (`Hello. The CodeSurf pe` + full `Hello. The CodeSurf peer-…` → overlapping
 * transcript). Prefer the accumulated stream over a mismatched index.
 */
export function remainingAssistantSnapshotText(blockText, alreadyStreamed, accumulated) {
  if (typeof blockText !== 'string' || blockText.length === 0) return ''
  if (blockText === alreadyStreamed || (accumulated && (accumulated === blockText || accumulated.endsWith(blockText)))) {
    return ''
  }
  if (alreadyStreamed && blockText.startsWith(alreadyStreamed)) {
    return blockText.slice(alreadyStreamed.length)
  }
  if (alreadyStreamed && alreadyStreamed.startsWith(blockText)) return ''
  if (accumulated && blockText.startsWith(accumulated)) {
    return blockText.slice(accumulated.length)
  }
  if (accumulated && accumulated.startsWith(blockText)) return ''
  return alreadyStreamed ? '' : blockText
}

function longestStreamedPrefix(blockText, streamedTextByIndex) {
  let best = ''
  if (typeof blockText !== 'string' || !streamedTextByIndex) return best
  for (const value of streamedTextByIndex.values()) {
    if (typeof value === 'string' && value && blockText.startsWith(value) && value.length > best.length) {
      best = value
    }
  }
  return best
}

function readPermissionGrants(homeDir) {
  try {
    const raw = JSON.parse(readFileSync(join(homeDir, 'permissions.json'), 'utf8'))
    const grants = Array.isArray(raw?.grants) ? raw.grants : []
    const now = Date.now()
    return grants.map(grant => {
      if (!grant || typeof grant !== 'object') return false
      if (grant.action !== 'allow' && grant.action !== 'deny') return false
      if (typeof grant.provider !== 'string' || typeof grant.toolName !== 'string') return false
      if (!['session', 'today', 'forever', 'never'].includes(grant.scope)) return false
      if (grant.expiresAt) {
        const expiry = Date.parse(grant.expiresAt)
        if (Number.isFinite(expiry) && expiry <= now) return false
      }
      return {
        ...grant,
        workspaceDir: normalizeWorkspaceDir(grant.workspaceDir),
      }
    }).filter(Boolean)
  } catch {
    return []
  }
}

function writePermissionGrants(homeDir, grants) {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 })
  chmodSync(homeDir, 0o700)
  const filePath = join(homeDir, 'permissions.json')
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  let replaced = false
  try {
    writeFileSync(tempPath, `${JSON.stringify({ version: 1, grants }, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    renameSync(tempPath, filePath)
    replaced = true
    chmodSync(filePath, 0o600)
  } finally {
    if (!replaced && existsSync(tempPath)) unlinkSync(tempPath)
  }
}

function normalizeWorkspaceDir(workspaceDir) {
  const trimmed = String(workspaceDir ?? '').trim()
  if (!trimmed) return null
  try {
    return resolve(trimmed)
  } catch {
    return trimmed
  }
}

function endOfTodayIso() {
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  return end.toISOString()
}

function makePermissionGrantId() {
  return `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function samePermissionTarget(grant, { provider, toolName, workspaceDir }) {
  const normalizedWorkspace = normalizeWorkspaceDir(workspaceDir)
  return grant.provider === provider
    && grant.toolName === toolName
    && (grant.workspaceDir ?? null) === normalizedWorkspace
}

function permissionAppliesToRequest(grant, { provider, toolName, workspaceDir }) {
  if (grant.provider !== provider || grant.toolName !== toolName) return false
  const grantWorkspace = normalizeWorkspaceDir(grant.workspaceDir)
  if (grantWorkspace === null) return true
  return grantWorkspace === normalizeWorkspaceDir(workspaceDir)
}

function resolvePersistedPermissionGrant(homeDir, request) {
  const grant = readPermissionGrants(homeDir).find(candidate => permissionAppliesToRequest(candidate, request))
  return grant?.action === 'allow' || grant?.action === 'deny' ? grant.action : null
}

function buildPermissionGrant(request, scope) {
  return {
    id: makePermissionGrantId(),
    provider: request.provider,
    toolName: request.toolName,
    action: scope === 'never' ? 'deny' : 'allow',
    scope,
    workspaceDir: normalizeWorkspaceDir(request.workspaceDir),
    title: request.title ?? null,
    description: request.description ?? null,
    blockedPath: request.blockedPath ?? null,
    createdAt: new Date().toISOString(),
    expiresAt: scope === 'today' ? endOfTodayIso() : null,
  }
}

function persistPermissionGrant(homeDir, request, scope) {
  const grant = buildPermissionGrant(request, scope)
  const grants = readPermissionGrants(homeDir).filter(existing => !samePermissionTarget(existing, request))
  writePermissionGrants(homeDir, [grant, ...grants])
  return grant
}

function normalizePath(value) {
  return String(value ?? '').trim().replace(/\/+$/, '')
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

function sanitizeCodexStderrText(text) {
  const cleaned = sanitizeToolOutputText(text)
  if (!cleaned) return ''

  return cleaned
    .split('\n')
    .filter(line => {
      const trimmed = line.trim()
      return trimmed.length > 0 && trimmed !== 'Reading additional input from stdin...'
    })
    .join('\n')
    .trim()
}

function sanitizeClaudeStderrText(text) {
  if (!text) return ''
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)
    .join('\n')
    .trim()
}

function sanitizeAgentCliDiagnostic(message) {
  const secretName = String.raw`[A-Z0-9_./-]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_./-]*`
  const quotedOrBareValue = String.raw`(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)`
  return String(message ?? '')
    .replace(new RegExp(`\\b(${secretName})\\s*=\\s*${quotedOrBareValue}`, 'gi'), '$1=[REDACTED]')
    .replace(/\b(authorization\s*:\s*(?:bearer|token)\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gi, '$1[REDACTED]')
    .replace(/\b(api\s*key|api[_-]?key|token|secret|password)\s*:\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gi, '$1: [REDACTED]')
}

function formatClaudeSdkError(error, stderrText) {
  const message = error instanceof Error ? error.message : String(error)
  const stderr = sanitizeClaudeStderrText(stderrText)
  if (!stderr) return message
  if (message && stderr.includes(message)) return stderr.slice(-6000)
  return `${message}\n\nClaude Code stderr:\n${stderr}`.slice(-6000)
}

function normalizeCodexShellCommand(command) {
  const trimmed = String(command ?? '').trim()
  const quotedMatch = trimmed.match(/^\/bin\/zsh -lc '([\s\S]*)'$/)
  if (quotedMatch) return quotedMatch[1].replace(/'\\''/g, "'")
  const plainMatch = trimmed.match(/^\/bin\/zsh -lc (.+)$/)
  if (plainMatch) return plainMatch[1].trim()
  return trimmed
}

function classifyCodexCommand(command) {
  const normalized = command.trim()
  if (/(^|\s)(rg|grep|fd|findstr)\b/.test(normalized)) return 'search'
  if (/(^|\s)(cat|sed|head|tail|less|more|bat|ls)\b/.test(normalized)) return 'read'
  return 'command'
}

function buildExploreToolName(entries) {
  const readCount = entries.filter(entry => entry.kind === 'read').length
  const searchCount = entries.filter(entry => entry.kind === 'search').length
  const labelParts = []
  if (readCount > 0) labelParts.push(`${readCount} file${readCount === 1 ? '' : 's'}`)
  if (searchCount > 0) labelParts.push(`${searchCount} search${searchCount === 1 ? '' : 'es'}`)
  return labelParts.length > 0 ? `Explored ${labelParts.join(', ')}` : 'Explored workspace'
}

function buildEditedToolName(fileChanges) {
  return `Edited ${fileChanges.length} file${fileChanges.length === 1 ? '' : 's'}`
}

const CLAUDE_CHECKPOINT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

function isClaudeCheckpointTool(toolName) {
  return CLAUDE_CHECKPOINT_TOOLS.has(String(toolName ?? ''))
}

function buildCheckpointLabel(toolName, filePaths, workspaceDir) {
  if (filePaths.length === 0) return `Before ${toolName}`
  if (filePaths.length === 1) return `Before ${toolName} ${getDisplayPath(filePaths[0], workspaceDir)}`
  return `Before ${toolName} (${filePaths.length} files)`
}

function buildCheckpointSummary(toolName, filePaths, workspaceDir) {
  const displayPaths = filePaths.slice(0, 2).map(filePath => getDisplayPath(filePath, workspaceDir))
  const suffix = filePaths.length > 2 ? ` +${filePaths.length - 2} more` : ''
  return `Saved checkpoint before ${toolName}${displayPaths.length > 0 ? ` for ${displayPaths.join(', ')}${suffix}` : ''}`
}

function buildRuntimeSessionEntryId(request, job) {
  const cardId = String(request?.cardId ?? '').trim()
  if (cardId) return `codesurf-runtime:${cardId}`
  return `codesurf-job:${job.id}`
}

function extractAnthropicCheckpointPaths(toolName, input, workspaceDir) {
  const source = input && typeof input === 'object' ? input : {}
  const resolveFile = (value) => {
    if (typeof value !== 'string' || !value.trim()) return null
    return resolveCodexFilePath(value, workspaceDir)
  }

  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write') {
    const filePath = resolveFile(source.file_path)
    return filePath ? [filePath] : []
  }

  if (toolName === 'NotebookEdit') {
    const filePath = resolveFile(source.notebook_path) ?? resolveFile(source.file_path)
    return filePath ? [filePath] : []
  }

  return []
}

function extractCodexCheckpointPaths(changes, workspaceDir) {
  const paths = []
  const seen = new Set()
  const pathFields = [
    'path',
    'previousPath',
    'previous_path',
    'oldPath',
    'old_path',
    'from',
    'sourcePath',
    'source_path',
  ]
  for (const change of Array.isArray(changes) ? changes : []) {
    for (const field of pathFields) {
      if (typeof change?.[field] !== 'string') continue
      const resolvedPath = resolveCodexFilePath(change[field], workspaceDir)
      if (seen.has(resolvedPath)) continue
      seen.add(resolvedPath)
      paths.push(resolvedPath)
    }
  }
  return paths
}

function countDiffStats(diff) {
  let additions = 0
  let deletions = 0
  for (const line of String(diff ?? '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions += 1
    if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions }
}

function changeTypeFromCodexKind(kind) {
  if (kind === 'add' || kind === 'delete' || kind === 'move') return kind
  return 'update'
}

function mergeFileChanges(fileChanges) {
  const merged = new Map()
  for (const change of fileChanges) {
    const key = `${change.path}::${change.previousPath ?? ''}::${change.changeType}`
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...change })
      continue
    }
    existing.additions += change.additions
    existing.deletions += change.deletions
    existing.diff = `${existing.diff}\n\n${change.diff}`.trim()
  }
  return Array.from(merged.values())
}

function normalizeTaskLabel(value, maxLength = 88) {
  const normalized = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return null
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trimEnd()}…`
    : normalized
}

function extractTaskLabelFromContent(content) {
  if (typeof content === 'string') return normalizeTaskLabel(content)
  if (Array.isArray(content)) {
    for (const entry of content) {
      const nested = extractTaskLabelFromContent(entry)
      if (nested) return nested
    }
    return null
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return normalizeTaskLabel(content.text)
    if (typeof content.content === 'string') return normalizeTaskLabel(content.content)
    if (Array.isArray(content.content)) return extractTaskLabelFromContent(content.content)
  }
  return null
}

function extractTaskLabelFromRequest(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : []
  for (const message of messages) {
    if (String(message?.role ?? '').trim() !== 'user') continue
    const label = extractTaskLabelFromContent(message?.content)
    if (label) return label
  }
  return `${String(request?.provider ?? 'agent').trim() || 'Agent'} task`
}

async function readSnapshotContent(filePath) {
  try {
    const buffer = await fs.readFile(filePath)
    if (buffer.includes(0)) return { existed: true, content: null }
    return { existed: true, content: buffer.toString('utf8') }
  } catch {
    return { existed: false, content: null }
  }
}

function getDisplayPath(filePath, workspaceDir) {
  const resolvedPath = resolve(filePath)
  const resolvedWorkspace = workspaceDir ? resolve(workspaceDir) : ''
  if (resolvedWorkspace && (resolvedPath === resolvedWorkspace || resolvedPath.startsWith(`${resolvedWorkspace}${sep}`))) {
    const rel = relative(resolvedWorkspace, resolvedPath)
    return rel || resolvedPath.split(sep).pop() || resolvedPath
  }
  return resolvedPath
}

function resolveCodexFilePath(filePath, workspaceDir) {
  if (workspaceDir && !String(filePath).startsWith('/')) return resolve(workspaceDir, filePath)
  return resolve(String(filePath))
}

function normalizeNoIndexDiffPaths(diff, beforePath, afterPath, displayPath) {
  let normalized = String(diff ?? '')
  if (beforePath) normalized = normalized.split(beforePath).join(`a/${displayPath}`)
  if (afterPath) normalized = normalized.split(afterPath).join(`b/${displayPath}`)
  return normalized.trim()
}

async function buildSnapshotDiff(before, currentPath) {
  const after = await readSnapshotContent(currentPath)
  if (before.content == null || (after.existed && after.content == null)) {
    return { diff: '', additions: 0, deletions: 0 }
  }

  const tempRoot = await fs.mkdtemp(join(tmpdir(), 'codesurf-codex-diff-'))
  const beforeTempPath = before.existed ? join(tempRoot, 'before', before.displayPath) : null
  const afterTempPath = after.existed ? join(tempRoot, 'after', before.displayPath) : null

  try {
    if (beforeTempPath) {
      await fs.mkdir(dirname(beforeTempPath), { recursive: true })
      await fs.writeFile(beforeTempPath, before.content ?? '', 'utf8')
    }
    if (afterTempPath) {
      await fs.mkdir(dirname(afterTempPath), { recursive: true })
      await fs.writeFile(afterTempPath, after.content ?? '', 'utf8')
    }

    const args = ['diff', '--no-index', '--no-ext-diff', '--unified=3', '--']
    args.push(beforeTempPath ?? '/dev/null', afterTempPath ?? '/dev/null')

    let diff = ''
    try {
      const result = await execFileAsync('git', args, { maxBuffer: 1024 * 1024 * 4 })
      diff = result.stdout || result.stderr || ''
    } catch (error) {
      if (error?.code === 1) {
        diff = error.stdout || error.stderr || ''
      } else {
        throw error
      }
    }

    const normalizedDiff = normalizeNoIndexDiffPaths(diff, beforeTempPath, afterTempPath, before.displayPath)
    const { additions, deletions } = countDiffStats(normalizedDiff)
    return { diff: normalizedDiff, additions, deletions }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

async function summarizeCodexFileChanges(changes, snapshots, workspaceDir) {
  const fileChanges = []
  for (const change of changes) {
    if (typeof change?.path !== 'string') continue
    const resolvedPath = resolveCodexFilePath(change.path, workspaceDir)
    const snapshot = snapshots.get(resolvedPath) ?? {
      displayPath: getDisplayPath(resolvedPath, workspaceDir),
      changeType: changeTypeFromCodexKind(change.kind),
      existed: false,
      content: null,
    }
    const diffSummary = await buildSnapshotDiff(snapshot, resolvedPath).catch(() => ({
      diff: '',
      additions: 0,
      deletions: 0,
    }))

    fileChanges.push({
      path: snapshot.displayPath,
      changeType: snapshot.changeType,
      additions: diffSummary.additions,
      deletions: diffSummary.deletions,
      diff: diffSummary.diff,
    })

    snapshots.delete(resolvedPath)
  }
  return mergeFileChanges(fileChanges)
}

async function runGit(args, cwd) {
  const result = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 1024 * 1024 * 8,
  })
  return (result.stdout || '').trim()
}

async function ensureProvisionedWorkspace(homeDir, projectContext) {
  const explicitWorkspace = normalizePath(projectContext?.workspaceDir)
  if (explicitWorkspace && existsSync(explicitWorkspace)) {
    return explicitWorkspace
  }

  const gitRemoteUrl = String(projectContext?.gitRemoteUrl ?? '').trim()
  if (!gitRemoteUrl) {
    throw new Error('Workspace path is unavailable on this host and no git remote was provided')
  }

  const repoNameRaw = String(projectContext?.repoName ?? basename(gitRemoteUrl.replace(/\.git$/i, '')) ?? 'project').trim()
  const repoName = repoNameRaw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
  const slug = `${repoName}-${createHash('sha1').update(gitRemoteUrl).digest('hex').slice(0, 10)}`
  const workspaceDir = join(homeDir, 'remote-projects', slug)
  const branch = String(projectContext?.gitBranch ?? '').trim()

  ensureDir(join(homeDir, 'remote-projects'))

  if (!existsSync(join(workspaceDir, '.git'))) {
    await execFileAsync('git', ['clone', gitRemoteUrl, workspaceDir], { maxBuffer: 1024 * 1024 * 8 })
  } else {
    await runGit(['remote', 'set-url', 'origin', gitRemoteUrl], workspaceDir).catch(() => {})
    await runGit(['fetch', 'origin', '--prune'], workspaceDir).catch(() => {})
  }

  if (branch) {
    await runGit(['fetch', 'origin', branch, '--prune'], workspaceDir).catch(() => {})
    const localBranches = await runGit(['branch', '--list', branch], workspaceDir).catch(() => '')
    if (localBranches.trim()) {
      await runGit(['checkout', branch], workspaceDir)
    } else {
      await runGit(['checkout', '-B', branch, `origin/${branch}`], workspaceDir).catch(async () => {
        await runGit(['checkout', '-B', branch], workspaceDir)
      })
    }
  }

  return workspaceDir
}

const validatedContextPrompt = Symbol('validatedContextPrompt')
const validatedStableContextPrompt = Symbol('validatedStableContextPrompt')
const validatedPerTurnContextPrompt = Symbol('validatedPerTurnContextPrompt')
const stableSessionContextKinds = new Set([
  'persona',
  'memory',
  'skills',
  'output-convention',
  'insight-convention',
  'activity-convention',
])

function contextPromptForRequest(request) {
  if (request && Object.prototype.hasOwnProperty.call(request, validatedContextPrompt)) {
    return request[validatedContextPrompt]
  }
  return undefined
}

function stableContextPromptForRequest(request) {
  if (request && Object.prototype.hasOwnProperty.call(request, validatedStableContextPrompt)) {
    return request[validatedStableContextPrompt]
  }
  return undefined
}

function perTurnContextPromptForRequest(request) {
  if (request && Object.prototype.hasOwnProperty.call(request, validatedPerTurnContextPrompt)) {
    return request[validatedPerTurnContextPrompt]
  }
  return undefined
}

function systemPromptForVolatility(context, volatility) {
  return context.fragments
    .filter(fragment => {
      if (fragment.placement !== 'system') return false
      const fragmentVolatility = fragment.volatility
        ?? (stableSessionContextKinds.has(fragment.kind) ? 'stable-session' : 'per-turn')
      return fragmentVolatility === volatility
    })
    .map(fragment => fragment.text)
    .join('\n\n') || undefined
}

function codexContextPromptForTurn(request, stableContextPrompt) {
  return [stableContextPrompt, perTurnContextPromptForRequest(request)]
    .map(value => String(value ?? '').trim())
    .filter(Boolean)
    .join('\n\n') || undefined
}

function buildAsyncExecutionPrompt(asyncExecution) {
  if (!asyncExecution || typeof asyncExecution !== 'object') return undefined

  const lines = [
    '## Async Execution',
    `- Active execution backend: ${String(asyncExecution.backend ?? 'unknown')} (${String(asyncExecution.hostLabel ?? 'unknown host')}).`,
  ]

  if (asyncExecution.providerNativeBackground) {
    lines.push('- Provider-native background agents may be available. Prefer them for subagents or delegated work when that keeps the main conversation responsive.')
  }

  if (asyncExecution.detachedDaemonAvailable) {
    lines.push('- CodeSurf also supports daemon-backed detached jobs that can continue outside the foreground chat.')
  }

  if (asyncExecution.requestedRunMode === 'background') {
    lines.push('- This turn is running as a detached background orchestration job. Continue autonomously and do not wait for interactive clarification from the foreground chat unless blocked.')
  } else if (asyncExecution.detachedDaemonAvailable) {
    lines.push('- If the user wants the main conversation to stay free while work continues, prefer detached daemon orchestration for the main task thread.')
  }

  return lines.join('\n')
}

function summarizeMemoryContext(contextBuckets, instructionPrompt) {
  return String(contextBuckets?.inspect?.summary ?? '').trim()
    || describeContextBucketsForTool(contextBuckets, instructionPrompt).summary
}

function buildMemoryContextInput(contextBuckets, instructionPrompt) {
  return describeContextBucketsForTool(contextBuckets, instructionPrompt).input
}

function boundOptionalContext(value, maxBytes, reason) {
  const normalized = String(value ?? '').trim()
  if (!normalized) {
    return {
      value: undefined,
      metadata: {
        originalBytes: 0,
        includedBytes: 0,
        truncated: false,
        truncationReason: null,
      },
    }
  }
  const bounded = truncateUtf8(normalized, maxBytes, { reason })
  return {
    value: bounded.text,
    metadata: {
      originalBytes: bounded.originalBytes,
      includedBytes: bounded.includedBytes,
      truncated: bounded.truncated,
      truncationReason: bounded.truncationReason,
    },
  }
}

function fragmentFor(context, kind) {
  return context.fragments.find(fragment => fragment.kind === kind)
}

function fragmentMetadata(context, kind) {
  const fragment = fragmentFor(context, kind)
  return fragment
    ? {
        originalBytes: fragment.originalBytes,
        includedBytes: fragment.includedBytes,
        truncated: fragment.truncated,
        truncationReason: fragment.truncated ? `maximum ${kind} context bytes (${fragment.maxUtf8Bytes})` : null,
      }
    : {
        originalBytes: 0,
        includedBytes: 0,
        truncated: false,
        truncationReason: null,
      }
}

function appendComposedUserContext(messages, userSuffix) {
  const suffix = String(userSuffix ?? '').trim()
  if (!suffix || !Array.isArray(messages)) return messages
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index
      break
    }
  }
  if (lastUserIndex < 0) return messages
  return messages.map((message, index) => index === lastUserIndex
    ? { ...message, content: `${String(message?.content ?? '')}\n\n${suffix}` }
    : message)
}

function extractTaggedUserContext(messages, openTag, closeTag) {
  if (!Array.isArray(messages)) return { messages, text: undefined }
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index
      break
    }
  }
  if (lastUserIndex < 0) return { messages, text: undefined }
  const content = String(messages[lastUserIndex]?.content ?? '')
  const marker = `\n\n${openTag}\n`
  const start = content.lastIndexOf(marker)
  if (start < 0 || !content.endsWith(`\n${closeTag}`)) {
    return { messages, text: undefined }
  }
  const valueStart = start + marker.length
  const valueEnd = content.length - closeTag.length - 1
  const text = content.slice(valueStart, valueEnd).trim() || undefined
  const nextMessages = messages.map((message, index) => index === lastUserIndex
    ? { ...message, content: content.slice(0, start).trimEnd() }
    : message)
  return { messages: nextMessages, text }
}

function extractComposedUserContext(messages) {
  const tags = [
    {
      key: 'room',
      open: '<codesurf_peer_context trust="untrusted" source="agent-room">',
      close: '</codesurf_peer_context>',
    },
    {
      key: 'fileReferences',
      open: '<codesurf_file_context trust="untrusted" source="workspace-files">',
      close: '</codesurf_file_context>',
    },
    {
      key: 'recentEdit',
      open: '<codesurf_recent_edit_context trust="untrusted" source="renderer-derived-file-state">',
      close: '</codesurf_recent_edit_context>',
    },
    {
      key: 'blockNotes',
      open: '<codesurf_block_notes_context trust="untrusted" source="renderer-derived-transcript">',
      close: '</codesurf_block_notes_context>',
    },
  ]
  let remainingMessages = messages
  const values = Object.fromEntries(tags.map(tag => [tag.key, []]))
  for (;;) {
    let stripped = false
    for (const tag of tags) {
      const extracted = extractTaggedUserContext(remainingMessages, tag.open, tag.close)
      if (extracted.messages === remainingMessages) continue
      remainingMessages = extracted.messages
      if (extracted.text) values[tag.key].unshift(extracted.text)
      stripped = true
      break
    }
    if (!stripped) break
  }
  return {
    messages: remainingMessages,
    room: values.room.join('\n\n') || undefined,
    fileReferences: values.fileReferences.join('\n\n') || undefined,
    recentEdit: values.recentEdit.join('\n\n') || undefined,
    blockNotes: values.blockNotes.join('\n\n') || undefined,
  }
}

export function revalidateDaemonContextRequest(request = {}) {
  const peerContext = buildPeerContextPrompt(request.peers)
  const primaryContext = extractComposedUserContext(request.messages)
  const expandedContext = extractComposedUserContext(request.expandedMessages)
  const skillsSummary = boundOptionalContext(
    request.skillsSummary,
    MAX_SKILLS_SUMMARY_BYTES,
    `maximum skills summary bytes (${MAX_SKILLS_SUMMARY_BYTES})`,
  )
  const roomContext = [
    request.roomContext ?? primaryContext.room ?? expandedContext.room,
    request.untrustedPeerContext,
  ].map(value => String(value ?? '').trim()).filter(Boolean).join('\n\n') || undefined
  const context = composeChatContext({
    persona: request?.agentMode?.systemPrompt,
    memory: request.memoryPrompt,
    skills: request.skillsPrompt,
    outputConvention: buildCodeSurfOutputConvention(),
    insightConvention: buildCodeSurfInsightConvention(),
    activityConvention: buildCodeSurfActivityConvention(),
    async: buildAsyncExecutionPrompt(request.asyncExecution),
    // Canvas peer topology is functional state, never system authority.
    peer: undefined,
    room: roomContext,
    fileReferences: request.fileReferencePrompt ?? primaryContext.fileReferences ?? expandedContext.fileReferences,
    recentEdit: request.recentEditContext ?? primaryContext.recentEdit ?? expandedContext.recentEdit,
    blockNotes: request.blockNotesContext ?? primaryContext.blockNotes ?? expandedContext.blockNotes,
  })
  const persona = fragmentFor(context, 'persona')
  const memory = fragmentFor(context, 'memory')
  const skills = fragmentFor(context, 'skills')
  return {
    request: {
      ...request,
      peers: peerContext.peers,
      [validatedContextPrompt]: context.systemPrompt,
      [validatedStableContextPrompt]: systemPromptForVolatility(context, 'stable-session'),
      [validatedPerTurnContextPrompt]: systemPromptForVolatility(context, 'per-turn'),
      contextPrompt: undefined,
      messages: appendComposedUserContext(primaryContext.messages, context.userSuffix),
      ...(Array.isArray(request.expandedMessages)
        ? { expandedMessages: appendComposedUserContext(expandedContext.messages, context.userSuffix) }
        : {}),
      memoryPrompt: memory?.text,
      roomContext: undefined,
      untrustedPeerContext: undefined,
      fileReferencePrompt: undefined,
      recentEditContext: undefined,
      blockNotesContext: undefined,
      skillsPrompt: skills?.text,
      skillsSummary: skillsSummary.value,
      ...(request?.agentMode && typeof request.agentMode === 'object'
        ? {
            agentMode: {
              ...request.agentMode,
              systemPrompt: persona?.text ?? '',
            },
          }
        : {}),
    },
    metadata: {
      context: context.metadata,
      memoryPrompt: fragmentMetadata(context, 'memory'),
      skillsPrompt: fragmentMetadata(context, 'skills'),
      skillsSummary: skillsSummary.metadata,
      personaPrompt: fragmentMetadata(context, 'persona'),
      roomContext: fragmentMetadata(context, 'room'),
      fileReferencePrompt: fragmentMetadata(context, 'file-reference'),
      peerContext: peerContext.metadata,
    },
  }
}

function buildClaudeAgentPrompt(contextPrompt) {
  return String(contextPrompt ?? '').trim() || undefined
}

function buildCodexPrompt(userText, contextPrompt) {
  const preamble = String(contextPrompt ?? '').trim() || undefined
  return preamble ? `${preamble}\n\n## User Request\n${userText}` : userText
}

// --- Omnigent wire helpers (used by runOmnigentJob) ----------------------
// Side-effecting fetch/CLI glue lives here at module scope; the pure parsing
// lives in omnigent-provider.mjs so it can be unit tested without this file's
// Claude-SDK import. Mirrors how runCodexSdkJob leans on codex-sdk-provider.mjs.

// Per-turn upper bound on a stalled stream/fetch (mirrors the CLI provider's
// DEFAULT_TIMEOUT_MS). The live SSE tail never closes per turn, so without this
// a stalled backend would hang the job forever.
const OMNIGENT_TURN_TIMEOUT_MS = 30 * 60 * 1000

async function omnigentFetchJson(baseUrl, path, apiKey, init = {}) {
  const response = await fetch(omnigentEndpointUrl(baseUrl, path), {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...omnigentAuthHeaders(apiKey),
      ...(init.headers ?? {}),
    },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `${path} returned HTTP ${response.status}`)
  }
  return response.json()
}

// Best-effort `omni server start`. Idempotent in practice: when a server is
// already running the CLI reports the live URL rather than erroring. The abort
// signal is wired into execFile so cancelling the job (or the turn timeout)
// kills the spawned start child instead of leaking it until its own timeout.
async function startLocalOmnigentServer(cli, signal) {
  const command = String(cli ?? '').trim() || OMNIGENT_DEFAULT_CLI
  const { stdout = '', stderr = '' } = await execFileAsync(command, ['server', 'start'], {
    encoding: 'utf8',
    timeout: 60_000,
    ...(signal ? { signal } : {}),
  })
  const combined = `${stdout}${stderr ? `\n${stderr}` : ''}`
  const fromStart = parseOmnigentServerUrl(combined)
  if (fromStart) return fromStart
  const status = parseOmnigentStatusJson(combined)
  if (status?.running && status.url) return normalizeOmnigentServerRoot(status.url)
  return null
}

async function resolveOmnigentAgentId(modelId, settings, baseUrl, apiKey, signal) {
  const fromModel = decodeOmnigentModelId(modelId)
  if (fromModel) return fromModel
  const configured = String(settings?.agentId ?? '').trim()
  if (configured) return configured
  const payload = await omnigentFetchJson(baseUrl, '/v1/agents?limit=100&order=asc', apiKey, signal ? { signal } : {})
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.agents)
        ? payload.agents
        : []
  const first = rows.find(row => typeof row?.id === 'string' && row.id.trim())
  if (!first) throw new Error('Omnigent returned no agents from /v1/agents; configure settings.omnigent.agentId.')
  return first.id.trim()
}

// Resolve the runner host_id to bind a new Omnigent session to. Without it the
// backend never launches a runner and every turn fails with runner_unavailable
// ("No runner bound for session"). settings.hostId wins (operator pin); else GET
// /v1/hosts and auto-pick the first online host (first host if none report
// status), mirroring the CLI provider. FAIL CLOSED on zero hosts: throw a clear
// error rather than create a session that is guaranteed to fail at turn time.
async function resolveOmnigentHostId(settings, baseUrl, apiKey, signal) {
  const configured = String(settings?.hostId ?? '').trim()
  if (configured) return configured
  const payload = await omnigentFetchJson(baseUrl, '/v1/hosts', apiKey, signal ? { signal } : {})
  const hosts = parseOmnigentHosts(payload)
  if (hosts.length === 0) {
    throw new Error('Omnigent returned no runner hosts from /v1/hosts; no runner host is registered. Start a runner host (or set settings.omnigent.hostId) before creating a session.')
  }
  const chosen = chooseOmnigentHost(hosts)
  if (!chosen?.id) throw new Error('Omnigent /v1/hosts returned hosts without a usable id.')
  return chosen.id
}

/** Claude SDK sessions are UUID v4; Codex/Omnigent thread ids are v7. Reject foreign ids. */
function isValidClaudeResumeSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return false
  const match = sessionId.trim().match(
    /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])([0-9a-f]{3})-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  )
  if (!match) return false
  return parseInt(match[1], 16) === 4
}

function resolveClaudeResumeSessionId(sessionId) {
  return isValidClaudeResumeSessionId(sessionId) ? sessionId : undefined
}

function omnigentTitleFromPrompt(text) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!oneLine) return 'CodeSurf session'
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine
}

// Build the `codex exec` argv for a request. Pure + exported so the daemon test
// can assert AgentMode.tools constrains the constructed command. Codex's CLI has
// no per-tool allow-list, so the allow-list maps onto the sandbox (the only real
// toolset lever): when it grants no write-capable tool, force read-only.
export const CLAUDE_ASK_USER_QUESTION_UNAVAILABLE =
  'Interactive questions are not available in this session. Do not interview the user. '
  + 'Pick sensible defaults, state them in one line, and carry on with the task. '
  + 'Only if you are genuinely blocked, ask ONE short question in plain text and end your turn.'

export function buildCodexExecArgs(request, workspaceDir, instructionPrompt = '', options = {}) {
  const lastUserMsg = [...(request.messages ?? [])].reverse().find(message => message.role === 'user')
  const codexMode = ['default', 'auto', 'read-only', 'full-access'].includes(request.mode)
    ? request.mode
    : 'default'
  // Per-mode sandbox + approval policy (and write-free allow-list → read-only).
  // THROWS CODEX_DENY_ALL_ERROR for an explicit deny-all ([]) — runCodexJob
  // catches it and surfaces the error instead of spawning Codex (fail closed).
  const sandboxApprovalFlags = codexSandboxApprovalFlags(codexMode, resolveAgentToolAllowList(request.agentMode))
  // Multi-turn continuity: when the request carries the Codex thread id from a
  // prior turn (emitted as a `thread.started` session event and echoed back by
  // the client as request.sessionId), resume that thread so the model keeps the
  // full conversation — `codex exec [OPTIONS] resume <threadId> [PROMPT]`.
  // Codex's CLI grammar requires every exec-level OPTION (--json, --model,
  // --ignore-user-config, --skip-git-repo-check, -C <dir>,
  // sandbox/approval flags) to precede the
  // `resume` subcommand; only SESSION_ID and PROMPT follow it. Placing `resume`
  // before the options makes codex reject the trailing flags (e.g.
  // `error: unexpected argument '-C' found`). Mirrors the runtime builder
  // (src/main/chat/providers/agent-mode-payloads.ts buildCodexSpawnArgs).
  // First turn (no sessionId) starts a fresh thread (unchanged behavior).
  const resumeArgs = request.sessionId ? ['resume', request.sessionId] : []
  const codexArgs = [
    'exec',
    '--json',
    '--model',
    request.model,
    ...sandboxApprovalFlags,
    '--ignore-user-config',
    '--skip-git-repo-check',
    ...(workspaceDir ? ['-C', workspaceDir] : []),
    ...resumeArgs,
  ]
  codexArgs.push(buildCodexPrompt(
    lastUserMsg?.content ?? '',
    codexContextPromptForTurn(
      request,
      Object.prototype.hasOwnProperty.call(options, 'contextPrompt')
        ? options.contextPrompt
        : stableContextPromptForRequest(request),
    ),
  ))
  return codexArgs
}

// Providers the @ai-sdk/harness backend can host. Module-level mirror of the
// closure-local set, so shouldUseHarness() stays a pure, exported predicate.
const HARNESS_CAPABLE_PROVIDERS = new Set(['claude', 'codex'])

// Decide whether a request routes through the harness backend vs a native
// provider path. Pure + exported so the daemon test can assert the routing
// decision without spawning a job. Three exclusions, in order:
//   1. Codex NEVER uses the harness — its adapter can't honor CodeSurf's 4
//      permission modes (it hardcodes danger-full-access). Native `codex exec`
//      honors them; runJob routes Codex to runCodexJob. (Pre-existing.)
//   2. CONTINUITY STOPGAP: foreground (interactive, multi-turn) Claude chat
//      must NOT use the harness. The harness createSession()s without a
//      resumeFrom payload and destroy()s after each turn (discarding
//      resumability), and emits its OWN session id — not the Claude SDK
//      conversation id — so a later turn can't resume the prior context from
//      either side. Result: turn 2 loses all history. The native runClaudeJob
//      path resumes correctly via { resume: request.sessionId } and persists a
//      resumable SDK session, so foreground Claude falls back to it. Gated on
//      runMode so BACKGROUND dispatched Claude runs keep the harness's worktree
//      isolation (single-shot autonomous tasks, not interactive multi-turn).
//      runMode is stable per-conversation (absent ⇒ foreground, matching the
//      existing canUseTool gate). Tradeoff: foreground Claude forgoes harness
//      worktree isolation — runClaudeJob still enforces agentMode.tools (SDK
//      `tools`), permissions (canUseTool), and checkpoints.
export function shouldUseHarness(request) {
  if (request?.useHarness !== true) return false
  if (!HARNESS_CAPABLE_PROVIDERS.has(request.provider)) return false
  if (request.provider === 'codex') return false
  if (request.provider === 'claude' && request.runMode !== 'background') return false
  return true
}

// Resolve the Hermes `--toolsets` value for a request. AgentMode.tools (when
// present) maps onto Hermes' coarse toolset categories and takes precedence over
// the explicit toolsets / mode mapping. Pure + exported for the daemon test.
export function hermesToolsetsForRequest(request) {
  const fromAllowList = hermesToolsetsFromAllowList(resolveAgentToolAllowList(request.agentMode))
  if (fromAllowList != null) return fromAllowList

  const explicitToolsets = Array.isArray(request.toolsets)
    ? request.toolsets.filter(Boolean).join(',')
    : String(request.toolsets ?? '').trim()
  if (explicitToolsets) return explicitToolsets

  const modeMap = {
    full: 'terminal,file,web,browser',
    terminal: 'terminal,file',
    web: 'web,browser',
    query: '',
  }
  return modeMap[request.mode ?? ''] ?? 'terminal,file,web'
}

function pushOpenCodeFlag(args, flag, value) {
  const str = String(value ?? '').trim()
  if (!str) return
  args.push(flag, str)
}

function buildOpenCodeRunArgs(request) {
  const args = ['run', '--format', 'json']
  pushOpenCodeFlag(args, '--model', request.model)
  pushOpenCodeFlag(args, '--agent', request.agent)
  pushOpenCodeFlag(args, '--session', request.sessionId)
  pushOpenCodeFlag(args, '--dir', request.cwd)
  if (request.bypassPermissions) args.push('--dangerously-skip-permissions')
  args.push(request.prompt)
  return args
}

const HERMES_MODEL_PROVIDER_PREFIXES = {
  anthropic: 'anthropic',
  arcee: 'arcee',
  'arcee-ai': 'arcee',
  copilot: 'copilot',
  'copilot-acp': 'copilot-acp',
  gemini: 'gemini',
  google: 'gemini',
  huggingface: 'huggingface',
  'kimi-coding': 'kimi-coding',
  'kimi-coding-cn': 'kimi-coding-cn',
  kilocode: 'kilocode',
  minimax: 'minimax',
  'minimax-cn': 'minimax-cn',
  nous: 'nous',
  nvidia: 'nvidia',
  'ollama-cloud': 'ollama-cloud',
  openai: 'openai',
  'openai-codex': 'openai-codex',
  openrouter: 'openrouter',
  stepfun: 'stepfun',
  'x-ai': 'xai',
  xai: 'xai',
  xiaomi: 'xiaomi',
  'z-ai': 'zai',
  zai: 'zai',
}

function resolveHermesModelSelection(model, provider) {
  const rawModel = String(model ?? '').trim()
  const explicitProvider = String(provider ?? '').trim()
  if (!rawModel) return { model: null, provider: explicitProvider || null }
  if (explicitProvider) return { model: rawModel, provider: explicitProvider }

  const slashIndex = rawModel.indexOf('/')
  if (slashIndex <= 0) return { model: rawModel, provider: null }

  const prefix = rawModel.slice(0, slashIndex).trim().toLowerCase()
  const remainder = rawModel.slice(slashIndex + 1).trim()
  const inferredProvider = HERMES_MODEL_PROVIDER_PREFIXES[prefix]
  if (!inferredProvider || !remainder) return { model: rawModel, provider: null }
  return { model: remainder, provider: inferredProvider }
}

function buildHermesChatArgs(request) {
  // Hermes Agent (Nous) 0.20.x has no --stream-json; argparse rejects it.
  // Only pass the flag when a caller has probed `hermes chat --help`.
  const outputFlag = request.streamJson === true ? '--stream-json' : '--quiet'
  const args = ['chat', '--query', request.prompt, outputFlag, '--source', 'tool']
  const selection = resolveHermesModelSelection(request.model, request.provider)
  pushOpenCodeFlag(args, '--model', selection.model)
  pushOpenCodeFlag(args, '--provider', selection.provider)
  pushOpenCodeFlag(args, '--toolsets', Array.isArray(request.toolsets) ? request.toolsets.join(',') : request.toolsets)
  pushOpenCodeFlag(args, '--resume', request.resumeSessionId)
  if (request.ignoreRules) args.push('--ignore-rules')
  if (request.bypassPermissions) args.push('--yolo')
  return args
}

export function stripHermesReasoningChrome(text) {
  return String(text ?? '')
    .split('\n')
    .filter(line => {
      const trimmed = line.trim()
      if (!trimmed) return true
      if (/^┌─\s*Reasoning\b/i.test(trimmed)) return false
      if (/^[┌└│├┤┬┴┼─━═]+$/.test(trimmed.replace(/\s/g, ''))) return false
      return true
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseHermesOutput(stdout) {
  let sessionId = null
  const textLines = []
  for (const line of String(stdout ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const match = line.match(/^\s*(?:session_id|session)\s*:\s*(.+?)\s*$/i)
    if (match) {
      if (!sessionId) sessionId = match[1].trim()
      continue
    }
    textLines.push(line)
  }
  return {
    sessionId,
    text: stripHermesReasoningChrome(textLines.join('\n').replace(/\n{3,}/g, '\n\n')),
  }
}

function extractAgentSessionId(value) {
  if (!value || typeof value !== 'object') return null
  const candidates = [
    value.sessionId,
    value.session_id,
    value.sessionID,
    value.thread_id,
    value.result?.sessionId,
    value.result?.session_id,
    value.result?.sessionID,
  ]
  if (value.type === 'session' || value.type === 'thread.started') {
    candidates.push(value.id)
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return null
}

function extractAgentContentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return ''
      return typeof part.text === 'string'
        ? part.text
        : typeof part.content === 'string'
          ? part.content
          : ''
    })
    .filter(Boolean)
    .join('')
}

function extractOpenCodeTextPayload(event) {
  if (!event || typeof event !== 'object') return ''
  if (typeof event.result === 'string') return event.result
  if (typeof event.text === 'string' && (event.role === 'assistant' || event.type === 'assistant')) return event.text
  if (typeof event.message === 'string' && (event.role === 'assistant' || event.type === 'assistant')) return event.message
  if (event.type === 'message' && event.role === 'assistant') return extractAgentContentText(event.content)
  if (event.role === 'assistant') return extractAgentContentText(event.content)
  if (event.type === 'assistant') return extractAgentContentText(event.message?.content ?? event.content)
  return ''
}

function sseEventEntry(payload) {
  const sequence = Number(payload?.sequence ?? 0)
  return {
    chunk: `data: ${JSON.stringify(payload)}\n\n`,
    jobId: payload?.jobId,
    sequence: Number.isFinite(sequence) ? sequence : 0,
    terminal: payload?.type === 'done',
  }
}

function responseIsClosed(res) {
  return Boolean(res?.destroyed || res?.writableEnded || res?.closed)
}

export function createSseSubscriberRegistry({
  maxQueuedEvents = 256,
  maxQueuedBytes = 1024 * 1024,
  drainTimeoutMs = 30_000,
  heartbeatMs = 15_000,
} = {}) {
  const subscribers = new Map()
  const eventLimit = Math.max(1, Number(maxQueuedEvents) || 256)
  const byteLimit = Math.max(1, Number(maxQueuedBytes) || 1024 * 1024)
  const drainLimitMs = Math.max(1, Number(drainTimeoutMs) || 30_000)
  let stopped = false

  function removeFromRegistry(record) {
    const current = subscribers.get(record.jobId)
    if (!current) return
    current.delete(record)
    if (current.size === 0) subscribers.delete(record.jobId)
  }

  function clearDrainTimer(record) {
    if (!record.drainTimer) return
    clearTimeout(record.drainTimer)
    record.drainTimer = null
  }

  function resolveDrainWaiters(record, writable) {
    const waiters = Array.from(record.drainWaiters)
    record.drainWaiters.clear()
    for (const resolveWaiter of waiters) resolveWaiter(writable)
  }

  function closeRecord(record, { destroy = false, end = true } = {}) {
    if (!record || record.closed) return
    record.closed = true
    clearDrainTimer(record)
    removeFromRegistry(record)
    record.res.off?.('drain', record.onDrain)
    record.res.off?.('finish', record.onFinish)
    record.res.off?.('close', record.onClose)
    record.res.off?.('error', record.onError)
    record.queue.length = 0
    record.replayBuffer.length = 0
    record.bufferedEvents = 0
    record.bufferedBytes = 0
    resolveDrainWaiters(record, false)

    if (destroy && !record.res.destroyed) {
      try { record.res.destroy?.() } catch {}
    } else if (end && !record.res.writableEnded && !record.res.destroyed) {
      try { record.res.end?.() } catch {}
    }
  }

  function markBlocked(record) {
    if (record.closed || record.blocked) return
    record.blocked = true
    record.drainTimer = setTimeout(() => {
      closeRecord(record, { destroy: true, end: false })
    }, drainLimitMs)
    record.drainTimer.unref?.()
  }

  function unaccountEntry(record, entry) {
    record.bufferedEvents = Math.max(0, record.bufferedEvents - 1)
    record.bufferedBytes = Math.max(0, record.bufferedBytes - entry.bytes)
  }

  function entryFits(record, entry) {
    if (entry.bytes <= byteLimit) return true
    closeRecord(record, { destroy: true, end: false })
    return false
  }

  function beginTerminalEnd(record) {
    if (record.closed || record.terminalEnding) return
    record.terminalEnding = true
    try {
      record.res.end?.()
    } catch {
      closeRecord(record, { destroy: true, end: false })
    }
  }

  // Persistent card streams only need a cursor for the requested replay job.
  // Other jobs are live-only, avoiding an unbounded per-job cursor map.
  function alreadySent(record, entry) {
    return entry.sequence > 0
      && (!record.persistent || entry.jobId === record.replayJobId)
      && entry.sequence <= record.lastSentSequence
  }

  function writeEntry(record, entry) {
    if (record.closed) return false
    if (!entryFits(record, entry)) return false
    if (responseIsClosed(record.res)) {
      closeRecord(record, { end: false })
      return false
    }

    let writable
    try {
      writable = record.res.write(entry.chunk)
    } catch {
      closeRecord(record, { destroy: true, end: false })
      return false
    }

    if ((!record.persistent || entry.jobId === record.replayJobId)
      && entry.sequence > record.lastSentSequence) {
      record.lastSentSequence = entry.sequence
    }
    if (!writable) markBlocked(record)
    if (entry.terminal && !record.persistent) {
      if (writable) {
        closeRecord(record)
      } else {
        // `ServerResponse.end()` does not guarantee the buffered terminal frame
        // reached a client that stopped reading. Keep the record and its drain
        // deadline alive until `finish`/`close`; shutdown can then destroy it.
        beginTerminalEnd(record)
      }
      return false
    }
    return !record.closed
  }

  function enqueue(record, entry, target) {
    if (record.closed) return false
    if (!entryFits(record, entry)) return false
    if (
      record.bufferedEvents + 1 > eventLimit
      || record.bufferedBytes + entry.bytes > byteLimit
    ) {
      closeRecord(record, { destroy: true, end: false })
      return false
    }
    target.push(entry)
    record.bufferedEvents += 1
    record.bufferedBytes += entry.bytes
    return true
  }

  function flushQueue(record) {
    while (!record.closed && !record.blocked && record.queue.length > 0) {
      const entry = record.queue.shift()
      unaccountEntry(record, entry)
      if (alreadySent(record, entry)) continue
      if (!writeEntry(record, entry)) return
    }
  }

  function handleDrain(record) {
    if (record.closed) return
    // A terminal frame that returned false is already ending. A `drain`
    // notification alone is not proof the response finished, so retain the
    // bounded destroy deadline until `finish` or `close`.
    if (record.terminalEnding) return
    clearDrainTimer(record)
    record.blocked = false
    flushQueue(record)
    if (!record.closed && !record.blocked) resolveDrainWaiters(record, true)
  }

  function register(jobId, res, { sinceSequence = 0, replaying = true, persistent = false, replayJobId = null } = {}) {
    const record = {
      jobId,
      persistent,
      replayJobId,
      res,
      queue: [],
      replayBuffer: [],
      replaying,
      blocked: false,
      terminalEnding: false,
      closed: false,
      bufferedEvents: 0,
      bufferedBytes: 0,
      drainTimer: null,
      drainWaiters: new Set(),
      lastSentSequence: Math.max(0, Number(sinceSequence) || 0),
      onDrain: null,
      onFinish: null,
      onClose: null,
      onError: null,
    }
    record.onDrain = () => handleDrain(record)
    record.onFinish = () => closeRecord(record, { end: false })
    record.onClose = () => closeRecord(record, { end: false })
    record.onError = () => closeRecord(record, { destroy: true, end: false })
    res.on?.('drain', record.onDrain)
    res.on?.('finish', record.onFinish)
    res.on?.('close', record.onClose)
    res.on?.('error', record.onError)

    const listeners = subscribers.get(jobId) ?? new Set()
    listeners.add(record)
    subscribers.set(jobId, listeners)
    if (stopped) {
      closeRecord(record)
    } else if (responseIsClosed(res)) {
      closeRecord(record, { end: false })
    }
    return record
  }

  function publish(jobId, payload) {
    const listeners = subscribers.get(jobId)
    if (!listeners) return
    const baseEntry = sseEventEntry(payload)
    for (const record of Array.from(listeners)) {
      if (record.closed || alreadySent(record, baseEntry)) continue
      const entry = { ...baseEntry, bytes: Buffer.byteLength(baseEntry.chunk) }
      if (record.replaying) {
        enqueue(record, entry, record.replayBuffer)
      } else if (record.blocked || record.queue.length > 0) {
        enqueue(record, entry, record.queue)
      } else {
        writeEntry(record, entry)
      }
    }
  }

  function waitForWritable(record) {
    if (record.closed) return Promise.resolve(false)
    if (!record.blocked) return Promise.resolve(true)
    return new Promise(resolveWaiter => {
      record.drainWaiters.add(resolveWaiter)
    })
  }

  async function sendReplay(record, payload) {
    if (record.closed) return false
    const entry = sseEventEntry(payload)
    entry.bytes = Buffer.byteLength(entry.chunk)
    if (alreadySent(record, entry)) return true
    if (!entryFits(record, entry)) return false
    if (!await waitForWritable(record)) return false
    return writeEntry(record, entry)
  }

  function finishReplay(record) {
    if (record.closed) return false
    record.replaying = false
    const buffered = record.replayBuffer
      .splice(0)
      .sort((a, b) => record.persistent ? 0 : a.sequence - b.sequence)
    for (const entry of buffered) {
      unaccountEntry(record, entry)
      if (record.closed || alreadySent(record, entry)) continue
      if (record.blocked || record.queue.length > 0) {
        if (!enqueue(record, entry, record.queue)) break
      } else if (!writeEntry(record, entry)) {
        break
      }
    }
    return !record.closed
  }

  function sendComment(record, comment) {
    if (record.closed || record.blocked) return false
    const chunk = comment.endsWith('\n\n') ? comment : `${comment}\n\n`
    return writeEntry(record, {
      chunk,
      bytes: Buffer.byteLength(chunk),
      sequence: 0,
      terminal: false,
    })
  }

  function pulseHeartbeat() {
    for (const listeners of subscribers.values()) {
      for (const record of Array.from(listeners)) {
        if (
          record.closed
          || record.blocked
          || record.replaying
          || record.queue.length > 0
          || record.replayBuffer.length > 0
        ) {
          continue
        }
        sendComment(record, ': ping\n\n')
      }
    }
  }

  const heartbeatTimer = heartbeatMs > 0
    ? setInterval(pulseHeartbeat, Math.max(1, Number(heartbeatMs) || 15_000))
    : null
  heartbeatTimer?.unref?.()

  function shutdown() {
    if (stopped) return
    stopped = true
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    const records = Array.from(subscribers.values()).flatMap(listeners => Array.from(listeners))
    for (const record of records) {
      closeRecord(record, {
        destroy: record.blocked || record.terminalEnding,
        end: !record.blocked && !record.terminalEnding,
      })
    }
    subscribers.clear()
  }

  return {
    register,
    publish,
    sendReplay,
    finishReplay,
    sendComment,
    pulseHeartbeat,
    close: closeRecord,
    shutdown,
    count(jobId) {
      if (jobId) return subscribers.get(jobId)?.size ?? 0
      let total = 0
      for (const listeners of subscribers.values()) total += listeners.size
      return total
    },
  }
}

export function createChatJobManager({
  homeDir,
  checkpointStore = null,
  claudeQuery = query,
  codexSdkFactory = null,
  harnessRunnerFactory = null,
  maxConcurrentJobs = 4,
  subscriberMaxQueuedEvents = 256,
  subscriberMaxQueuedBytes = 1024 * 1024,
  subscriberDrainTimeoutMs = 30_000,
  heartbeatMs = 15_000,
  timelineMaxQueuedEvents = 512,
  timelineMaxQueuedBytes = 4 * 1024 * 1024,
  timelineMaxFailedRecords = 128,
  timelineAppendMaxAttempts = 3,
  timelineAppendRetryDelayMs = 25,
  timelineAppend = (path, data) => fs.appendFile(path, data, 'utf8'),
  timelineReadStream = path => createReadStream(path),
  metadataWrite = (path, data) => fs.writeFile(path, data, 'utf8'),
}) {
  const jobsDir = join(homeDir, 'jobs')
  const timelinesDir = join(homeDir, 'timelines')
  ensureDir(jobsDir)
  ensureDir(timelinesDir)

  // daemon-01: bound how many jobs actually execute at once. The daemon is a
  // single process shared by every host; an unthrottled burst of chat:send
  // (e.g. a kanban board auto-running many cards) would otherwise spawn N
  // concurrent SDK queries / CLI children and exhaust CPU/memory/FDs/rate
  // limits. Jobs over the cap sit in status 'queued' (already a recognized
  // status) and start FIFO as slots free in runJob's finally.
  const MAX_CONCURRENT_JOBS = Math.max(1, Number(maxConcurrentJobs) || 4)
  let activeJobCount = 0
  const jobQueue = [] // { live, request, workspaceDir }
  // D3: once shutdown begins the manager is irreversibly closing — no new
  // starts are admitted and the queue is never pumped again, so a running
  // job's unwind cannot launch a job that shutdown's cancel sweep never saw.
  let closing = false

  // D1: idempotent start. A client that retries POST /chat/job/start after an
  // unknown outcome (lost response, timeout) sends the same startRequestId; the
  // retry must resolve to the job the first attempt created instead of
  // executing the prompt a second time. Pending promises are stored so an
  // in-flight duplicate coalesces; failed starts are dropped so a retry can
  // try again; the map is bounded FIFO so it cannot grow without limit.
  const START_REQUEST_ID_MAX_LENGTH = 200
  const START_REQUEST_MEMORY = 1000
  const startRequestsById = new Map() // startRequestId -> Promise<metadata>

  // Harness backend (@ai-sdk/harness) is opt-in per request and loaded lazily so
  // its ai@7-canary dependency graph never enters the daemon process unless a
  // harness job is actually requested. Existing provider paths are unaffected.
  // Routing decision lives in the module-level shouldUseHarness() predicate.
  let harnessRunnerPromise = null
  function getHarnessRunner() {
    if (!harnessRunnerPromise) {
      harnessRunnerPromise = harnessRunnerFactory
        ? Promise.resolve(harnessRunnerFactory({ homeDir }))
        : import('./harness-runtime.mjs').then(m => m.createHarnessRunner({ homeDir }))
    }
    return harnessRunnerPromise
  }

  const liveJobs = new Map()
  const stableSessionContexts = new StableSessionContextCache()
  const stableContextAnnouncements = new StableContextAnnouncementCache()

  function selectCodexStableContext(request) {
    return stableSessionContexts.select({
      workspaceId: request.workspaceId,
      cardId: request.cardId,
      provider: 'codex',
      sessionId: request.sessionId,
      contextPrompt: stableContextPromptForRequest(request),
    })
  }

  function bindJobProcess(job, proc) {
    job.proc = proc
    job.cancel = async () => {
      if (job.processTerminationPromise) {
        return await job.processTerminationPromise
      }
      const pending = terminateProcessTree(proc).then(result => {
        job.processTerminationResult = result
        job.terminationFailed = !result.confirmed
        return result
      }).finally(() => {
        if (job.processTerminationPromise === pending && !job.processTerminationResult?.confirmed) {
          job.processTerminationPromise = null
        }
      })
      job.processTerminationPromise = pending
      return await pending
    }
  }

  async function waitForJobRunnerSettlement(job, timeoutMs = 3_000) {
    if (job.runnerFinished) return true
    const runPromise = job.runPromise
    if (!runPromise) return false
    return await Promise.race([
      Promise.resolve(runPromise).then(() => true, () => true),
      new Promise(resolve => setTimeout(() => resolve(false), timeoutMs)),
    ])
  }

  const sessionPermissionGrants = new Map()
  const pendingToolPermissions = new Map()
  const subscriberRegistry = createSseSubscriberRegistry({
    maxQueuedEvents: subscriberMaxQueuedEvents,
    maxQueuedBytes: subscriberMaxQueuedBytes,
    drainTimeoutMs: subscriberDrainTimeoutMs,
    heartbeatMs,
  })

  const cardSubscriberRegistry = createSseSubscriberRegistry({
    maxQueuedEvents: subscriberMaxQueuedEvents,
    maxQueuedBytes: subscriberMaxQueuedBytes,
    drainTimeoutMs: subscriberDrainTimeoutMs,
    heartbeatMs,
  })

  function publishEvent(jobId, payload, metadata) {
    subscriberRegistry.publish(jobId, payload)
    if (metadata?.cardId) cardSubscriberRegistry.publish(metadata.cardId, payload)
  }

  // Timeline persistence is a bounded, recoverable per-job queue. A rejected
  // append is retried in-place so later writes are never chained to a poisoned
  // promise. If retries or queue limits are exhausted, the provider is stopped
  // and the job fails closed in memory; durable metadata remains behind the
  // timeline gap rather than claiming a completion that cannot be replayed.
  const METADATA_FLUSH_MS = 250
  const TIMELINE_EVENT_LIMIT = Math.max(1, Number(timelineMaxQueuedEvents) || 512)
  const TIMELINE_BYTE_LIMIT = Math.max(1, Number(timelineMaxQueuedBytes) || 4 * 1024 * 1024)
  const TIMELINE_FAILED_RECORD_LIMIT = Math.max(1, Number(timelineMaxFailedRecords) || 128)
  const TIMELINE_APPEND_ATTEMPTS = Math.max(1, Number(timelineAppendMaxAttempts) || 3)
  const TIMELINE_RETRY_DELAY_MS = Math.max(0, Number(timelineAppendRetryDelayMs) || 0)
  const metadataFlushTimers = new Map() // jobId -> timeout
  const metadataWriteTails = new Map() // jobId -> serialized atomic write
  const timelinePersistence = new Map() // jobId -> bounded queue record
  const timelineWriteTails = new Map() // jobId -> latest queued entry promise
  const reconciliationLocks = new Map() // jobId -> Promise<metadata>
  const failedCleanupTasks = new Set()
  let timelineFailureOrdinal = 0

  class TimelinePersistenceError extends Error {
    constructor(jobId, cause) {
      const rawDetail = cause instanceof Error ? cause.message : String(cause)
      const detail = truncateUtf8(rawDetail, 1_024, {
        reason: 'maximum timeline persistence diagnostic bytes (1024)',
      }).text
      super(`Timeline persistence failed for job ${jobId}: ${detail}`)
      this.name = 'TimelinePersistenceError'
      this.cause = cause
      this.detail = detail
    }
  }

  function isTimelinePersistenceError(error) {
    return error instanceof TimelinePersistenceError
      || error?.name === 'TimelinePersistenceError'
  }

  function timelineRecord(jobId) {
    let record = timelinePersistence.get(jobId)
    if (!record) {
      record = {
        jobId,
        entries: [],
        queuedBytes: 0,
        processing: false,
        failed: false,
        error: null,
        failureEvents: [],
        failureMetadata: null,
        failureOrdinal: 0,
        durableFailureMetadata: null,
        finalizationPromise: null,
        repairByteLength: null,
      }
      timelinePersistence.set(jobId, record)
    }
    return record
  }

  function scheduleFailedRecordFinalization(record) {
    if (record.finalizationPromise) return record.finalizationPromise
    const finalization = (async () => {
      const persistedMetadata = await readJobMetadata(record.jobId)
        ?? record.failureMetadata
      if (!persistedMetadata) return null

      if (Number.isFinite(record.repairByteLength)) {
        await fs.truncate(jobTimelinePath(record.jobId), record.repairByteLength)
      }
      let inspected = await inspectTimeline(record.jobId)
      if (inspected.integrityError) {
        await fs.truncate(jobTimelinePath(record.jobId), inspected.contiguousByteLength)
        inspected = await inspectTimeline(record.jobId)
      }
      const publicError = record.failureMetadata?.error
        ?? `Timeline persistence failed: ${record.error?.detail ?? record.error?.message ?? 'Unknown error'}`
      try {
        if (!inspected.terminalSeen) {
          if (inspected.lastEventType !== 'error') {
            await appendReconciliationEvent(record.jobId, {
              jobId: record.jobId,
              sequence: inspected.maxSequence + 1,
              timestamp: Date.now(),
              type: 'error',
              error: publicError,
            })
          }
          inspected = await inspectTimeline(record.jobId)
          if (!inspected.terminalSeen) {
            await appendReconciliationEvent(record.jobId, {
              jobId: record.jobId,
              sequence: inspected.maxSequence + 1,
              timestamp: Date.now(),
              type: 'done',
            })
          }
          inspected = await inspectTimeline(record.jobId)
        }
      } catch {
        // The timeline may remain unavailable even though atomic metadata writes
        // work. Persist a truthful terminal state at the actual disk high-water
        // mark; never claim the in-memory failure-event sequences are durable.
        inspected = await inspectTimeline(record.jobId)
      }

      const now = new Date().toISOString()
      const terminalMetadata = {
        ...persistedMetadata,
        status: 'failed',
        error: publicError,
        updatedAt: now,
        completedAt: persistedMetadata.completedAt ?? now,
        lastSequence: inspected.maxSequence,
        timelinePersistenceFailed: !inspected.terminalSeen,
      }
      await writeJobMetadata(terminalMetadata)
      record.durableFailureMetadata = terminalMetadata
      return terminalMetadata
    })().finally(() => {
      failedCleanupTasks.delete(finalization)
    })
    // Keep an observer attached even if callers only need eventual cleanup.
    finalization.catch(() => {})
    record.finalizationPromise = finalization
    failedCleanupTasks.add(finalization)
    return finalization
  }

  function enforceFailedTimelineRecordLimit() {
    const evictable = Array.from(timelinePersistence.values())
      .filter(record => record.failed && !liveJobs.has(record.jobId))
      .sort((a, b) => a.failureOrdinal - b.failureOrdinal)
    const excess = evictable.length - TIMELINE_FAILED_RECORD_LIMIT
    if (excess <= 0) return

    for (const record of evictable.slice(0, excess)) {
      const evict = () => {
        if (timelinePersistence.get(record.jobId) !== record) return
        timelinePersistence.delete(record.jobId)
        timelineWriteTails.delete(record.jobId)
        reconciliationLocks.delete(record.jobId)
        clearMetadataFlush(record.jobId)
        enforceFailedTimelineRecordLimit()
      }
      // Durable finalization is best-effort. The original metadata remains in an
      // active state when it fails, which restart reconciliation understands.
      // A persistent storage fault must not defeat the aggregate memory cap.
      void scheduleFailedRecordFinalization(record).then(evict, evict)
    }
  }

  function failTimelinePersistence(record, cause) {
    if (record.failed) return record.error
    const failure = cause instanceof TimelinePersistenceError
      ? cause
      : new TimelinePersistenceError(record.jobId, cause)
    record.failed = true
    record.error = failure
    record.failureOrdinal = ++timelineFailureOrdinal
    clearMetadataFlush(record.jobId)

    for (const entry of record.entries) entry.reject(failure)

    const live = liveJobs.get(record.jobId)
    if (live) {
      try { live.cancel?.() } catch {}
      cancelPendingToolPermissionsForJob(record.jobId, 'Timeline persistence failed')
      const now = new Date().toISOString()
      const baseSequence = Math.max(0, Number(live.metadata?.lastSequence) || 0)
      const publicError = `Timeline persistence failed: ${failure.detail}`
      const errorEvent = {
        jobId: record.jobId,
        sequence: baseSequence + 1,
        timestamp: Date.now(),
        type: 'error',
        error: publicError,
      }
      const doneEvent = {
        jobId: record.jobId,
        sequence: baseSequence + 2,
        timestamp: Date.now(),
        type: 'done',
      }
      record.failureEvents = [errorEvent, doneEvent]
      record.failureMetadata = {
        ...live.metadata,
        status: 'failed',
        error: publicError,
        updatedAt: now,
        completedAt: now,
        lastSequence: doneEvent.sequence,
      }
      live.metadata = record.failureMetadata
      live.terminalEmitted = true
      live.persistenceFailed = true
      publishEvent(record.jobId, errorEvent, live.metadata)
      publishEvent(record.jobId, doneEvent, live.metadata)
    }

    // The high-water and bounded terminal snapshot above are sufficient for
    // same-process state/reporting. Do not retain every failed payload and its
    // serialized line for the daemon lifetime (up to the per-job byte cap).
    record.entries.length = 0
    record.queuedBytes = 0
    timelineWriteTails.delete(record.jobId)
    enforceFailedTimelineRecordLimit()
    return failure
  }

  async function waitBeforeTimelineRetry(attempt) {
    if (TIMELINE_RETRY_DELAY_MS <= 0) return
    await new Promise(resolve => setTimeout(
      resolve,
      Math.min(1_000, TIMELINE_RETRY_DELAY_MS * (2 ** Math.max(0, attempt - 1))),
    ))
  }

  async function pumpTimelineWrites(record) {
    if (record.processing || record.failed) return
    record.processing = true
    try {
      while (!record.failed && record.entries.length > 0) {
        const entry = record.entries[0]
        let lastError = null
        let persisted = false
        let repairByteLength = null
        for (let attempt = 1; attempt <= TIMELINE_APPEND_ATTEMPTS; attempt += 1) {
          try {
            await timelineAppend(jobTimelinePath(record.jobId), entry.line)
            persisted = true
            break
          } catch (error) {
            lastError = error
            // appendFile-style failures can be outcome-uncertain. If the exact
            // sequence is already visible at the ordered timeline high-water
            // mark, treat it as committed instead of retrying a duplicate.
            try {
              const inspected = await inspectTimeline(record.jobId, {
                expectedSerialized: entry.line.slice(0, -1),
                expectedSequence: Number(entry.payload?.sequence ?? 0),
              })
              if (!inspected.integrityError && inspected.exactRecordCommitted) {
                persisted = true
                break
              }
              if (
                inspected.integrityError
                || inspected.maxSequence >= Number(entry.payload?.sequence ?? 0)
              ) {
                repairByteLength = inspected.contiguousByteLength
                lastError = new Error(
                  inspected.integrityError
                    ?? `timeline sequence ${entry.payload?.sequence} contains different event content`,
                )
                break
              }
            } catch {}
            if (attempt < TIMELINE_APPEND_ATTEMPTS) await waitBeforeTimelineRetry(attempt)
          }
        }
        if (!persisted) {
          if (Number.isFinite(repairByteLength)) {
            record.repairByteLength = repairByteLength
          }
          failTimelinePersistence(record, lastError ?? new Error('timeline append failed'))
          break
        }

        record.entries.shift()
        record.queuedBytes = Math.max(0, record.queuedBytes - entry.bytes)
        if (timelineWriteTails.get(record.jobId) === entry.promise && record.entries.length === 0) {
          timelineWriteTails.delete(record.jobId)
        }
        entry.resolve()
      }
    } finally {
      record.processing = false
      if (!record.failed && record.entries.length === 0) {
        timelinePersistence.delete(record.jobId)
      }
    }
  }

  function enqueueTimelineWrite(jobId, payload) {
    const record = timelineRecord(jobId)
    if (record.failed) throw record.error
    const line = `${JSON.stringify(payload)}\n`
    const bytes = Buffer.byteLength(line)
    if (
      record.entries.length + 1 > TIMELINE_EVENT_LIMIT
      || record.queuedBytes + bytes > TIMELINE_BYTE_LIMIT
    ) {
      throw failTimelinePersistence(
        record,
        new Error(
          `pending timeline queue limit exceeded (${TIMELINE_EVENT_LIMIT} events, ${TIMELINE_BYTE_LIMIT} bytes)`,
        ),
      )
    }

    let resolveEntry
    let rejectEntry
    const promise = new Promise((resolve, reject) => {
      resolveEntry = resolve
      rejectEntry = reject
    })
    // Every promise has a rejection observer even for streaming events whose
    // caller intentionally does not await disk latency.
    promise.catch(() => {})
    record.entries.push({
      payload,
      line,
      bytes,
      promise,
      resolve: resolveEntry,
      reject: rejectEntry,
    })
    record.queuedBytes += bytes
    timelineWriteTails.set(jobId, promise)
    void pumpTimelineWrites(record)
    return promise
  }

  function snapshotPendingTimelineEvents(jobId, sinceSequence, throughSequence) {
    const events = []
    let maxSequence = Math.max(0, sinceSequence)
    let terminalSeen = false
    const record = timelinePersistence.get(jobId)
    const pending = [
      ...(record?.entries.map(entry => entry.payload) ?? []),
      ...(record?.failureEvents ?? []),
    ]
    for (const payload of pending) {
      const sequence = Number(payload?.sequence ?? 0)
      if (!Number.isFinite(sequence) || sequence <= 0 || sequence > throughSequence) continue
      maxSequence = Math.max(maxSequence, sequence)
      if (payload?.type === 'done') terminalSeen = true
      if (sequence > sinceSequence) events.push(payload)
    }
    events.sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0))
    return { events, maxSequence, terminalSeen }
  }

  function jobMetaPath(jobId) {
    return join(jobsDir, `${jobId}.json`)
  }

  function jobTimelinePath(jobId) {
    return join(timelinesDir, `${jobId}.jsonl`)
  }

  async function readJobMetadata(jobId) {
    try {
      return JSON.parse(await fs.readFile(jobMetaPath(jobId), 'utf8'))
    } catch {
      return null
    }
  }

  async function writeJobMetadataNow(job) {
    // Atomic write: a crash/SIGKILL mid-write must not leave a truncated
    // {jobId}.json — a corrupt record is invisible to the dashboard AND
    // un-prunable by retention sweep (it skips on parse error), leaking the
    // file and its timeline forever. Write to a unique temp file then rename.
    const finalPath = jobMetaPath(job.id)
    const tmpPath = `${finalPath}.tmp-${randomUUID()}`
    try {
      await metadataWrite(tmpPath, `${JSON.stringify(job, null, 2)}\n`)
      await fs.rename(tmpPath, finalPath)
    } catch (err) {
      try { await fs.unlink(tmpPath) } catch {}
      throw err
    }
  }

  async function writeJobMetadata(job) {
    const snapshot = { ...job }
    const previous = metadataWriteTails.get(job.id)
    const write = (previous ? previous.catch(() => {}) : Promise.resolve())
      .then(() => writeJobMetadataNow(snapshot))
    metadataWriteTails.set(job.id, write)
    try {
      await write
    } finally {
      if (metadataWriteTails.get(job.id) === write) {
        metadataWriteTails.delete(job.id)
      }
    }
  }

  async function stageJobMetadata(job) {
    const pendingWrite = metadataWriteTails.get(job.id)
    if (pendingWrite) await pendingWrite.catch(() => {})
    const finalPath = jobMetaPath(job.id)
    const tmpPath = `${finalPath}.tmp-${randomUUID()}`
    try {
      await metadataWrite(tmpPath, `${JSON.stringify(job, null, 2)}\n`)
    } catch (error) {
      try { await fs.unlink(tmpPath) } catch {}
      throw error
    }
    return {
      async commit() {
        await fs.rename(tmpPath, finalPath)
      },
      async discard() {
        try { await fs.unlink(tmpPath) } catch {}
      },
    }
  }

  function clearMetadataFlush(jobId) {
    const timer = metadataFlushTimers.get(jobId)
    if (timer) {
      clearTimeout(timer)
      metadataFlushTimers.delete(jobId)
    }
  }

  function scheduleMetadataFlush(jobId) {
    if (metadataFlushTimers.has(jobId)) return
    const timer = setTimeout(() => {
      metadataFlushTimers.delete(jobId)
      const live = liveJobs.get(jobId)
      if (!live?.metadata || live.terminalFinalizing || live.terminalEmitted) return
      const persistence = timelinePersistence.get(jobId)
      if (persistence?.failed) return
      const timelineWrite = timelineWriteTails.get(jobId)
      if (!timelineWrite) {
        void writeJobMetadata(live.metadata).catch(() => {})
        return
      }
      void timelineWrite.then(() => {
        if (timelinePersistence.get(jobId)?.failed) return
        if (timelineWriteTails.has(jobId)) {
          scheduleMetadataFlush(jobId)
          return
        }
        const currentLive = liveJobs.get(jobId)
        if (
          currentLive?.metadata
          && !currentLive.terminalFinalizing
          && !currentLive.terminalEmitted
        ) {
          return writeJobMetadata(currentLive.metadata)
        }
      }).catch(() => {
        // Fail closed: never advance durable metadata beyond a timeline gap.
        // The pending event map remains available for same-process SSE replay.
      })
    }, METADATA_FLUSH_MS)
    timer.unref?.()
    metadataFlushTimers.set(jobId, timer)
  }

  async function appendEvent(jobId, event, options = {}) {
    const live = liveJobs.get(jobId)
    const currentMetadata = live?.metadata ?? await readJobMetadata(jobId)
    if (!currentMetadata) return null

    // Cancellation owns the terminal sequence once requested. Provider output
    // arriving during TERM grace (including a direct child's close handler)
    // is stale and must not overtake the confirmed cancellation result.
    if (live?.cancelRequested && options.allowDuringCancellation !== true) {
      return null
    }

    // Idempotent terminals: once a 'done' has fired for a job, ignore further
    // terminal appends. Prevents the duplicate error+done pair when cancelJob
    // and the runner's own catch both emit terminals (the second pair would
    // otherwise write a confusing duplicate timeline + re-run status logic).
    if (live?.terminalEmitted || live?.terminalFinalizing) {
      return null
    }

    // Work on a copy until the event has been accepted by the bounded queue.
    // A synchronous queue-limit failure must not advance metadata to a
    // sequence that can never exist in the timeline.
    const metadata = { ...currentMetadata }
    metadata.lastSequence = Number(metadata.lastSequence ?? 0) + 1
    metadata.updatedAt = new Date().toISOString()
    if (event.sessionId) metadata.sessionId = event.sessionId
    if (event.type === 'error') {
      metadata.error = event.error ?? 'Unknown error'
    } else if (event.type === 'done') {
      metadata.status = metadata.error ? 'failed' : 'completed'
      metadata.completedAt = new Date().toISOString()
    }

    const payload = {
      jobId,
      sequence: metadata.lastSequence,
      timestamp: Date.now(),
      ...event,
    }

    if (event.type === 'done') {
      if (live) live.terminalFinalizing = true
      clearMetadataFlush(jobId)
      const pendingTimelineWrite = timelineWriteTails.get(jobId)
      if (pendingTimelineWrite) await pendingTimelineWrite

      // Prepare terminal metadata in a private temp file before the closing
      // timeline event, then atomically install it only after that exact event
      // is durable. A crash therefore leaves either active metadata (which
      // startup reconciliation fails closed) or a fully committed terminal.
      let stagedMetadata
      try {
        stagedMetadata = await stageJobMetadata(metadata)
      } catch (error) {
        throw failTimelinePersistence(
          timelineRecord(jobId),
          new Error(
            `terminal metadata persistence failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        )
      }

      let terminalStartByte
      try {
        terminalStartByte = (await fs.stat(jobTimelinePath(jobId))).size
      } catch (error) {
        await stagedMetadata.discard()
        throw failTimelinePersistence(
          timelineRecord(jobId),
          new Error(
            `terminal timeline inspection failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        )
      }

      try {
        await enqueueTimelineWrite(jobId, payload)
      } catch (error) {
        await stagedMetadata.discard()
        console.error(
          `[chat-jobs] timeline append failed for job ${jobId} at sequence ${payload.sequence}:`,
          error,
        )
        return payload
      }

      try {
        await stagedMetadata.commit()
      } catch (error) {
        await stagedMetadata.discard()
        try { await fs.truncate(jobTimelinePath(jobId), terminalStartByte) } catch {}
        const record = timelineRecord(jobId)
        record.repairByteLength = terminalStartByte
        throw failTimelinePersistence(
          record,
          new Error(
            `terminal metadata commit failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        )
      }

      if (live) {
        live.metadata = metadata
        live.terminalEmitted = true
      }
      publishEvent(jobId, payload, metadata)
      cancelPendingToolPermissionsForJob(jobId, 'Job completed')
      return payload
    }

    // Accept non-closing events into the bounded queue before fanout. The queue
    // starts its append concurrently, but provider delivery does not await disk
    // latency.
    const timelineWrite = enqueueTimelineWrite(jobId, payload)
    if (live) live.metadata = metadata
    publishEvent(jobId, payload, metadata)

    // daemon-07: flush metadata immediately on terminal/session events (status,
    // completedAt, sessionId must be durable right away) or when the job has no
    // live record to debounce against; otherwise coalesce rapid delta writes.
    const isTerminalEvent = event.type === 'done' || event.type === 'error'
    if (isTerminalEvent || event.sessionId || !live) {
      clearMetadataFlush(jobId)
      let timelinePersisted = true
      try {
        await timelineWrite
      } catch (error) {
        timelinePersisted = false
        console.error(
          `[chat-jobs] timeline append failed for job ${jobId} at sequence ${payload.sequence}:`,
          error,
        )
      }
      if (timelinePersisted) await writeJobMetadata(metadata)
    } else {
      scheduleMetadataFlush(jobId)
    }

    if (event.type === 'done' || event.type === 'error') {
      cancelPendingToolPermissionsForJob(jobId, event.type === 'done' ? 'Job completed' : 'Job failed')
    }

    return payload
  }

  function permissionKey(request) {
    return `${request.provider}::${request.toolName}::${normalizeWorkspaceDir(request.workspaceDir) ?? ''}`
  }

  function resolveStoredPermission(request) {
    const sessionGrant = sessionPermissionGrants.get(permissionKey(request))
    if (sessionGrant?.action === 'allow' || sessionGrant?.action === 'deny') return sessionGrant.action
    return resolvePersistedPermissionGrant(homeDir, request)
  }

  function storeSessionPermissionGrant(request) {
    const grant = buildPermissionGrant(request, 'session')
    sessionPermissionGrants.set(permissionKey(request), grant)
    return grant
  }

  function toolPermissionKey(jobId, toolUseID) {
    return `${jobId}::${toolUseID ?? ''}`
  }

  async function awaitToolPermissionAnswer(job, toolUseID, permissionRequest) {
    const key = toolPermissionKey(job.id, toolUseID)
    const prior = pendingToolPermissions.get(key)
    if (prior) {
      try { prior.reject(new Error('Tool permission superseded')) } catch {}
      pendingToolPermissions.delete(key)
    }

    return await new Promise((resolve, reject) => {
      pendingToolPermissions.set(key, { resolve, reject })
      void appendEvent(job.id, {
        type: 'tool_permission_request',
        toolId: toolUseID,
        provider: permissionRequest.provider,
        toolName: permissionRequest.toolName,
        title: permissionRequest.title ?? null,
        description: permissionRequest.description ?? null,
        blockedPath: permissionRequest.blockedPath ?? null,
        workspaceDir: permissionRequest.workspaceDir ?? null,
      }).catch(error => {
        pendingToolPermissions.delete(key)
        reject(error)
      })
    })
  }

  function answerToolPermission(jobId, toolUseID, decision) {
    const validDecisions = new Set(['deny', 'never', 'once', 'session', 'today', 'forever'])
    if (!validDecisions.has(decision)) {
      return { ok: false, error: 'invalid decision' }
    }
    const pending = pendingToolPermissions.get(toolPermissionKey(jobId, toolUseID))
    if (!pending) {
      return { ok: false, error: 'no pending request' }
    }
    pendingToolPermissions.delete(toolPermissionKey(jobId, toolUseID))
    pending.resolve(decision)
    return { ok: true }
  }

  function cancelPendingToolPermissionsForJob(jobId, reason = 'Job cancelled') {
    const prefix = `${jobId}::`
    for (const [key, pending] of pendingToolPermissions.entries()) {
      if (!key.startsWith(prefix)) continue
      pendingToolPermissions.delete(key)
      try { pending.reject(new Error(reason)) } catch {}
    }
  }

  async function createDaemonCheckpoint(job, request, toolName, filePaths, metadata = {}) {
    const workspaceId = String(request?.workspaceId ?? '').trim()
    if (!checkpointStore || typeof checkpointStore.createCheckpoint !== 'function') return { ok: true, skipped: true }
    if (!workspaceId) return { ok: true, skipped: true }
    if (!Array.isArray(filePaths) || filePaths.length === 0) return { ok: true, skipped: true }

    try {
      const checkpointWorkspaceDir = workspaceDirFromJob(job)
      const response = checkpointStore.createCheckpoint(workspaceId, buildRuntimeSessionEntryId(request, job), {
        label: buildCheckpointLabel(toolName, filePaths, checkpointWorkspaceDir),
        reason: `tool:${toolName}`,
        files: filePaths,
        workspaceRoots: checkpointWorkspaceDir ? [checkpointWorkspaceDir] : [],
        source: 'daemon-chat-job',
        metadata: {
          provider: request?.provider ?? null,
          model: request?.model ?? null,
          toolName,
          cardId: request?.cardId ?? null,
          jobId: job.id,
          ...metadata,
        },
      })
      if (!response?.ok) {
        return { ok: false, error: response?.error ?? `Failed to create checkpoint for ${toolName}` }
      }
      const checkpointId = response.checkpoint?.id
      if (checkpointId) {
        const toolId = `codesurf-checkpoint-${checkpointId}`
        await appendEvent(job.id, { type: 'tool_start', toolId, toolName: 'Checkpoint saved' })
        await appendEvent(job.id, {
          type: 'tool_summary',
          toolId,
          toolName: 'Checkpoint saved',
          text: buildCheckpointSummary(toolName, filePaths, checkpointWorkspaceDir),
        })
      }
      return { ok: true, checkpointId }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message }
    }
  }

  function workspaceDirFromJob(job) {
    return typeof job?.metadata?.workspaceDir === 'string' ? job.metadata.workspaceDir : undefined
  }

  async function runClaudeJob(job, request, workspaceDir, instructionPrompt) {
    const lastUserMsg = [...(request.messages ?? [])].reverse().find(message => message.role === 'user')
    if (!lastUserMsg) {
      await appendEvent(job.id, { type: 'error', error: 'No user message' })
      await appendEvent(job.id, { type: 'done' })
      return
    }

    const abortController = new AbortController()
    job.cancel = () => abortController.abort()
    let claudeStderr = ''

    // Defense-in-depth: only resume when the sessionId maps to a real on-disk
    // Claude transcript. A foreign/stale id (e.g. a codex thread id handed over
    // after a provider switch) would otherwise make the SDK return num_turns:0
    // with no assistant content — an empty reply. When there's no transcript we
    // omit `resume` so the model runs a fresh turn instead.
    const resumeTranscriptPath = await findClaudeResumeTranscript(request.sessionId, workspaceDir)
    const willResume = Boolean(resumeTranscriptPath)
    if (request.sessionId && !willResume) {
      console.warn(`[chat-jobs] claude job ${job.id}: no transcript for session ${request.sessionId}; starting fresh instead of resuming`)
    }

    const modeMap = {
      default: 'default',
      acceptEdits: 'acceptEdits',
      plan: 'plan',
      bypassPermissions: 'bypassPermissions',
    }
    const grantOnlyMode = request.mode === 'dontAsk' || request.mode === 'grant'
    const permMode = modeMap[request.mode ?? ''] ?? 'default'
    const thinkingMap = {
      adaptive: { type: 'adaptive' },
      none: { type: 'disabled' },
      low: { type: 'enabled', budget_tokens: 2048 },
      medium: { type: 'enabled', budget_tokens: 8192 },
      high: { type: 'enabled', budget_tokens: 32768 },
      max: { type: 'enabled', budget_tokens: 131072 },
    }
    const claudeResumeSessionId = resolveClaudeResumeSessionId(request.sessionId)
    const claudeExecutable = resolveClaudeExecutable(homeDir)
    const options = {
      model: request.model,
      ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
      abortController,
      persistSession: true,
      includePartialMessages: true,
      permissionMode: permMode,
      ...(permMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: async (toolName, input, toolOptions) => {
        // Daemon jobs have no interactive question surface. Without this the
        // tool errored and the model fell back to a one-question-per-turn
        // interview in plain text, which reads as the agent repeating itself.
        if (toolName === 'AskUserQuestion') {
          return {
            behavior: 'deny',
            message: CLAUDE_ASK_USER_QUESTION_UNAVAILABLE,
            toolUseID: toolOptions?.toolUseID,
          }
        }
        if (permMode !== 'bypassPermissions') {
          const permissionRequest = {
            provider: 'claude',
            toolName,
            title: typeof toolOptions?.title === 'string' ? toolOptions.title : null,
            description: typeof toolOptions?.description === 'string' ? toolOptions.description : null,
            blockedPath: typeof toolOptions?.blockedPath === 'string' ? toolOptions.blockedPath : null,
            workspaceDir,
          }
          const storedDecision = resolveStoredPermission(permissionRequest)
          if (storedDecision === 'deny') {
            return {
              behavior: 'deny',
              message: `Permission for ${toolName} is set to Never. Clear it in Settings -> Permissions or with \`codesurf permissions clear <grant-id>\` to re-enable prompts.`,
              toolUseID: toolOptions?.toolUseID,
            }
          }
          if (storedDecision !== 'allow') {
            const canAsk = !grantOnlyMode && request.runMode !== 'background' && typeof request.cardId === 'string' && request.cardId.trim()
            if (!canAsk) {
              return {
                behavior: 'deny',
                message: `Permission required for ${toolName}. Save an all-day or all-time grant from an interactive chat, or run \`codesurf permissions allow claude ${toolName} --workspace ${workspaceDir || process.cwd()}\` before starting this daemon job.`,
                toolUseID: toolOptions?.toolUseID,
              }
            }

            const sdkToolUseID = typeof toolOptions?.toolUseID === 'string'
              ? toolOptions.toolUseID
              : null
            const toolUseID = sdkToolUseID ?? `claude-permission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            let decision = 'deny'
            try {
              decision = await awaitToolPermissionAnswer(job, toolUseID, permissionRequest)
            } catch {
              return {
                behavior: 'deny',
                message: 'Tool permission request was cancelled.',
                toolUseID: sdkToolUseID ?? toolOptions?.toolUseID,
              }
            }

            await appendEvent(job.id, {
              type: 'tool_permission_resolved',
              toolId: toolUseID,
              toolName,
              decision,
            })

            if (decision === 'deny' || decision === 'never') {
              if (decision === 'never') persistPermissionGrant(homeDir, permissionRequest, 'never')
              return {
                behavior: 'deny',
                message: decision === 'never'
                  ? 'Tool permission permanently denied. Future calls will be auto-rejected.'
                  : 'Tool permission denied by the user.',
                toolUseID: sdkToolUseID ?? toolOptions?.toolUseID,
              }
            }

            if (decision === 'session') storeSessionPermissionGrant(permissionRequest)
            else if (decision === 'today' || decision === 'forever') persistPermissionGrant(homeDir, permissionRequest, decision)
          }
        }

        const checkpointPaths = extractAnthropicCheckpointPaths(toolName, input, workspaceDir)
        if (isClaudeCheckpointTool(toolName) && checkpointPaths.length === 0) {
          const message = `Checkpoint creation failed before ${toolName}: no checkpointable file path was provided`
          await appendEvent(job.id, { type: 'error', error: message })
          return {
            behavior: 'deny',
            message,
            toolUseID: toolOptions?.toolUseID,
          }
        }

        const checkpoint = await createDaemonCheckpoint(
          job,
          request,
          toolName,
          checkpointPaths,
          { toolUseID: typeof toolOptions?.toolUseID === 'string' ? toolOptions.toolUseID : null },
        )
        if (!checkpoint.ok) {
          const message = `Checkpoint creation failed before ${toolName}: ${checkpoint.error ?? 'unknown error'}`
          await appendEvent(job.id, { type: 'error', error: message })
          return {
            behavior: 'deny',
            message,
            toolUseID: toolOptions?.toolUseID,
          }
        }
        // The SDK schema requires updatedInput on allow; omitting it failed
        // every call that reached here with a ZodError.
        return { behavior: 'allow', updatedInput: input, toolUseID: toolOptions?.toolUseID }
      },
      thinking: thinkingMap[request.thinking ?? ''] ?? { type: 'adaptive' },
      cwd: workspaceDir || undefined,
      stderr: data => { claudeStderr += data },
      ...(willResume ? { resume: claudeResumeSessionId ?? request.sessionId } : {}),
    }

    // Agent-definition tools allow-list → restrict the built-in tools the model
    // may use (null/absent = all default tools). AgentMode.tools names are
    // already Claude-style (Read/Glob/Grep/…), so they pass through verbatim.
    // Set it BOTH at the top level (governs when no custom agent is active) AND
    // on the custom agent definition below — when `options.agent` is set, the
    // active agent's own `tools` field governs its toolset (SDK AgentDefinition),
    // so the allow-list must be applied there too or it would be a no-op for any
    // agent definition that also carries a systemPrompt.
    const agentToolAllowList = Array.isArray(request.agentMode?.tools) ? request.agentMode.tools : null
    if (agentToolAllowList) {
      options.tools = agentToolAllowList
    }

    const systemPrompt = buildClaudeAgentPrompt(contextPromptForRequest(request))
    if (systemPrompt) {
      options.agent = 'codesurf'
      options.agents = {
        codesurf: {
          description: 'CodeSurf canvas AI agent with peer context',
          prompt: systemPrompt,
          ...(agentToolAllowList ? { tools: agentToolAllowList } : {}),
        },
      }
    }

    try {
      const q = claudeQuery({ prompt: lastUserMsg.content, options })
      job.query = q
      let emittedDone = false
      let assistantText = ''
      let sawAssistantOutput = false
      const streamedTextByIndex = new Map()
      let streamTurn = 0
      let currentThinkingId = null

      let lastEmittedSessionId = null
      for await (const msg of q) {
        const sid = msg?.session_id
        // Once per change, not per SDK message: a session event forces a
        // durable metadata write, and one long turn emitted ~2800 of them.
        if (sid && sid !== lastEmittedSessionId) {
          lastEmittedSessionId = sid
          await appendEvent(job.id, { type: 'session', sessionId: sid })
        }

        if (msg.type === 'stream_event') {
          const evt = msg.event
          if (evt?.type === 'content_block_delta') {
            if (evt.delta?.type === 'text_delta' && evt.delta.text) {
              const key = `${streamTurn}:${evt.index ?? 0}`
              streamedTextByIndex.set(key, (streamedTextByIndex.get(key) ?? '') + evt.delta.text)
              assistantText += evt.delta.text
              sawAssistantOutput = true
              await appendEvent(job.id, { type: 'text', text: evt.delta.text })
            } else if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
              sawAssistantOutput = true
              await appendEvent(job.id, {
                type: 'thinking',
                text: evt.delta.thinking,
                ...(currentThinkingId ? { thinkingId: currentThinkingId } : {}),
              })
            } else if (evt.delta?.type === 'input_json_delta' && evt.delta.partial_json) {
              await appendEvent(job.id, { type: 'tool_input', text: evt.delta.partial_json })
            }
          } else if (evt?.type === 'content_block_start') {
            if (evt.content_block?.type === 'tool_use') {
              sawAssistantOutput = true
              await appendEvent(job.id, {
                type: 'tool_start',
                toolName: evt.content_block.name,
                toolId: evt.content_block.id,
              })
            } else if (evt.content_block?.type === 'thinking') {
              currentThinkingId = `think-${streamTurn}-${evt.index ?? 0}`
              await appendEvent(job.id, { type: 'thinking_start', thinkingId: currentThinkingId })
            }
          } else if (evt?.type === 'content_block_stop') {
            await appendEvent(job.id, {
              type: 'block_stop',
              index: evt.index,
              ...(currentThinkingId ? { thinkingId: currentThinkingId } : {}),
            })
            currentThinkingId = null
          }
        } else if (msg.type === 'assistant') {
          const message = msg.message
          let sawToolUse = false
          if (message?.content) {
            for (let idx = 0; idx < message.content.length; idx += 1) {
              const block = message.content[idx]
              if (block.type === 'tool_use') {
                sawToolUse = true
                sawAssistantOutput = true
                await appendEvent(job.id, {
                  type: 'tool_use',
                  toolName: block.name,
                  toolId: block.id,
                  toolInput: JSON.stringify(block.input, null, 2),
                })
              } else if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
                const key = `${streamTurn}:${idx}`
                const alreadyStreamed = longestStreamedPrefix(block.text, streamedTextByIndex)
                  || streamedTextByIndex.get(key)
                  || ''
                const tail = remainingAssistantSnapshotText(block.text, alreadyStreamed, assistantText)
                if (tail.length > 0) {
                  assistantText += tail
                  sawAssistantOutput = true
                  await appendEvent(job.id, { type: 'text', text: tail })
                  streamedTextByIndex.set(key, block.text)
                }
              }
            }
          }
          // includePartialMessages emits intermediate assistant snapshots of the
          // same turn. Only advance the stream-index namespace after tools,
          // when the next assistant message is actually a new turn.
          if (sawToolUse) streamTurn += 1
        } else if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
          // Tool results come back as user messages. Forward each one keyed by
          // its tool_use_id so clients can close the matching call as it
          // finishes, instead of seeing no tool activity until the turn ends.
          for (const block of msg.message.content) {
            if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
            const text = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.filter(part => part?.type === 'text').map(part => part.text).join('\n')
                : ''
            sawAssistantOutput = true
            await appendEvent(job.id, {
              type: 'tool_summary',
              toolId: block.tool_use_id,
              text: text.length > 20_000 ? `${text.slice(0, 20_000)}\n…[truncated]` : text,
              ...(block.is_error === true ? { isError: true } : {}),
            })
          }
        } else if (msg.type === 'tool_use_summary') {
          if (typeof msg.summary === 'string' && msg.summary.trim()) sawAssistantOutput = true
          await appendEvent(job.id, {
            type: 'tool_summary',
            text: msg.summary,
          })
        } else if (msg.type === 'tool_progress') {
          sawAssistantOutput = true
          await appendEvent(job.id, {
            type: 'tool_progress',
            toolName: msg.tool_name,
            elapsed: msg.elapsed_time_seconds,
          })
        } else if (msg.type === 'result') {
          emittedDone = true
          const resultText = typeof msg.result === 'string' ? msg.result.trim() : ''
          if (!assistantText.trim() && resultText) {
            assistantText = resultText
            sawAssistantOutput = true
            await appendEvent(job.id, { type: 'text', text: resultText })
          }
          if (!sawAssistantOutput && !resultText) {
            await appendEvent(job.id, {
              type: 'error',
              error: 'Claude finished without assistant output. Only preflight/context events were emitted, so the turn was not saved as a blank reply. Please resend the message.',
            })
            await appendEvent(job.id, {
              type: 'done',
              cost: msg.total_cost_usd,
              turns: msg.num_turns,
              sessionId: msg.session_id,
            })
            continue
          }
          await appendEvent(job.id, {
            type: 'done',
            cost: msg.total_cost_usd,
            turns: msg.num_turns,
            resultText: msg.result,
            sessionId: msg.session_id,
          })
        }
      }

      if (!emittedDone) {
        if (!sawAssistantOutput && !assistantText.trim()) {
          await appendEvent(job.id, {
            type: 'error',
            error: 'Claude stream ended before producing assistant output. Only preflight/context events were emitted, so the turn was not saved as a blank reply. Please resend the message.',
          })
          await appendEvent(job.id, { type: 'done' })
        } else {
          await appendEvent(job.id, { type: 'done' })
        }
      }
    } catch (error) {
      await appendEvent(job.id, {
        type: 'error',
        error: formatClaudeSdkError(error, claudeStderr),
      })
      await appendEvent(job.id, { type: 'done' })
    }
  }

  async function runCodexSdkJob(job, request, workspaceDir, instructionPrompt, stableContext) {
    const lastUserMsg = [...(request.messages ?? [])].reverse().find(message => message.role === 'user')
    if (!lastUserMsg) {
      await appendEvent(job.id, { type: 'error', error: 'No user message' })
      await appendEvent(job.id, { type: 'done' })
      return true
    }

    let threadOptions
    try {
      threadOptions = buildCodexSdkThreadOptions(request, workspaceDir)
    } catch (err) {
      await appendEvent(job.id, { type: 'error', error: err instanceof Error ? err.message : String(err) })
      await appendEvent(job.id, { type: 'done' })
      return true
    }

    let codex
    try {
      codex = await createCodexSdkClient({ codexSdkFactory })
    } catch (err) {
      if (err?.code === CODEX_SDK_UNAVAILABLE_CODE) {
        console.warn(`[chat-jobs] Codex SDK unavailable; falling back to CLI: ${err.message}`)
        return false
      }
      await appendEvent(job.id, { type: 'error', error: err instanceof Error ? err.message : String(err) })
      await appendEvent(job.id, { type: 'done' })
      return true
    }
    if (job.cancelRequested) return true

    const abortController = new AbortController()
    job.cancel = () => abortController.abort()

    const prompt = buildCodexPrompt(
      lastUserMsg.content ?? '',
      codexContextPromptForTurn(request, stableContext.contextPrompt),
    )

    const pendingSnapshots = new Map()
    const aggregatedFileChanges = new Map()
    const exploreEntries = []
    const emittedSessionIds = new Set()
    let editsStarted = false
    let exploreStarted = false
    let commandSeq = 0
    let fatalFailure = null
    let providerError = false
    let providerSessionId = typeof request.sessionId === 'string'
      ? request.sessionId.trim() || null
      : null
    let sawProviderAcceptance = false

    const emitSession = async (sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId.trim()) return
      const normalized = sessionId.trim()
      providerSessionId = normalized
      if (emittedSessionIds.has(normalized)) return
      emittedSessionIds.add(normalized)
      await appendEvent(job.id, { type: 'session', sessionId: normalized })
    }

    const abortSdkTurn = () => {
      try { abortController.abort() } catch {}
    }

    const handleCodexJsonEvent = async (evt) => {
      if (!evt || typeof evt !== 'object') return
      if (evt.type === 'thread.started' && typeof evt.thread_id === 'string') {
        await emitSession(evt.thread_id)
        return
      }
      if (fatalFailure) return

      if (evt.type === 'turn.failed' || evt.type === 'error') {
        fatalFailure = evt.error?.message ?? evt.message ?? `Codex SDK event: ${evt.type}`
        await appendEvent(job.id, { type: 'error', error: String(fatalFailure) })
        abortSdkTurn()
        return
      }

      if (
        evt.type === 'turn.started'
        || evt.type === 'turn.completed'
        || evt.type === 'item.started'
        || evt.type === 'item.completed'
      ) {
        sawProviderAcceptance = true
      }

      if (evt.type === 'item.started') {
        const item = evt.item
        if (item?.type === 'file_change' && Array.isArray(item.changes)) {
          const checkpointPaths = extractCodexCheckpointPaths(item.changes, workspaceDir)
          if (item.changes.length > 0 && checkpointPaths.length === 0) {
            fatalFailure = 'no checkpointable file paths were provided by Codex SDK file_change'
            await appendEvent(job.id, {
              type: 'error',
              error: `Checkpoint creation failed before Codex SDK file change: ${fatalFailure}`,
            })
            abortSdkTurn()
            return
          }
          const checkpoint = await createDaemonCheckpoint(job, request, 'Codex file change', checkpointPaths, {
            itemType: 'file_change',
            provider: 'codex-sdk',
          })
          if (!checkpoint.ok) {
            fatalFailure = checkpoint.error ?? 'unknown error'
            await appendEvent(job.id, {
              type: 'error',
              error: `Checkpoint creation failed before Codex SDK file change: ${fatalFailure}`,
            })
            abortSdkTurn()
            return
          }

          for (const change of item.changes) {
            if (typeof change?.path !== 'string') continue
            const resolvedPath = resolveCodexFilePath(change.path, workspaceDir)
            const snapshot = await readSnapshotContent(resolvedPath)
            pendingSnapshots.set(resolvedPath, {
              displayPath: getDisplayPath(resolvedPath, workspaceDir),
              changeType: changeTypeFromCodexKind(change.kind),
              existed: snapshot.existed,
              content: snapshot.content,
            })
          }
        }
        return
      }

      if (evt.type !== 'item.completed') return
      const item = evt.item
      if (!item || typeof item !== 'object') return

      if (item.type === 'agent_message' && typeof item.text === 'string' && item.text) {
        await appendEvent(job.id, { type: 'text', text: item.text })
        return
      }

      if (item.type === 'command_execution' && typeof item.command === 'string') {
        const command = normalizeCodexShellCommand(item.command)
        const kind = classifyCodexCommand(command)
        const MAX_CMD_OUTPUT = 64 * 1024
        const rawOutput = sanitizeToolOutputText(typeof item.aggregated_output === 'string' ? item.aggregated_output : '')
        const output = rawOutput.length > MAX_CMD_OUTPUT
          ? rawOutput.slice(0, MAX_CMD_OUTPUT) + '\n…[truncated]'
          : rawOutput
        if (kind === 'search' || kind === 'read') {
          if (!exploreStarted) {
            await appendEvent(job.id, { type: 'tool_start', toolId: 'codex-explore', toolName: 'Exploring workspace' })
            exploreStarted = true
          }
          exploreEntries.push({ label: command, command, output, kind })
          await appendEvent(job.id, {
            type: 'tool_summary',
            toolId: 'codex-explore',
            toolName: buildExploreToolName(exploreEntries),
            commandEntries: [...exploreEntries],
          })
        } else {
          const toolId = `codex-cmd-${commandSeq++}`
          await appendEvent(job.id, { type: 'tool_start', toolId, toolName: 'exec_command' })
          await appendEvent(job.id, {
            type: 'tool_summary',
            toolId,
            toolName: 'exec_command',
            commandEntries: [{ label: command, command, output, kind: 'command' }],
          })
        }
        return
      }

      if (item.type === 'file_change' && Array.isArray(item.changes)) {
        const fileChanges = await summarizeCodexFileChanges(item.changes, pendingSnapshots, workspaceDir)
        if (fileChanges.length === 0) return
        for (const change of fileChanges) {
          const key = `${change.path}::${change.previousPath ?? ''}::${change.changeType}`
          aggregatedFileChanges.set(key, change)
        }
        const merged = Array.from(aggregatedFileChanges.values())
        if (!editsStarted) {
          await appendEvent(job.id, {
            type: 'tool_start',
            toolId: 'codex-file-changes',
            toolName: buildEditedToolName(merged),
          })
          editsStarted = true
        }
        await appendEvent(job.id, {
          type: 'tool_summary',
          toolId: 'codex-file-changes',
          toolName: buildEditedToolName(merged),
          fileChanges: merged,
        })
      }
    }

    try {
      const { thread, resumed, sessionId } = startCodexSdkThread(codex, request, threadOptions)
      if (resumed) await emitSession(sessionId)
      const { events } = await thread.runStreamed(prompt, { signal: abortController.signal })
      for await (const evt of events) {
        await handleCodexJsonEvent(evt)
      }
    } catch (err) {
      providerError = true
      if (!fatalFailure) {
        const message = err instanceof Error ? err.message : String(err)
        await appendEvent(job.id, { type: 'error', error: sanitizeAgentCliDiagnostic(message) })
      }
    }

    stableSessionContexts.complete(stableContext, {
      accepted: sawProviderAcceptance
        && !providerError
        && !fatalFailure
        && !job.cancelRequested,
      sessionId: providerSessionId,
    })

    await appendEvent(job.id, { type: 'done' })
    return true
  }

  async function runCodexJob(job, request, workspaceDir, instructionPrompt) {
    const stableContext = selectCodexStableContext(request)
    if (shouldUseCodexSdkProvider(request)) {
      const handledBySdk = await runCodexSdkJob(
        job,
        request,
        workspaceDir,
        instructionPrompt,
        stableContext,
      )
      if (handledBySdk) return
    }

    const lastUserMsg = [...(request.messages ?? [])].reverse().find(message => message.role === 'user')
    if (!lastUserMsg) {
      await appendEvent(job.id, { type: 'error', error: 'No user message' })
      await appendEvent(job.id, { type: 'done' })
      return
    }

    let codexArgs
    try {
      codexArgs = buildCodexExecArgs(request, workspaceDir, instructionPrompt, {
        contextPrompt: stableContext.contextPrompt,
      })
    } catch (err) {
      // Fail closed: e.g. an unenforceable deny-all tool list on Codex. Surface
      // the specific reason instead of spawning Codex with weaker enforcement.
      await appendEvent(job.id, { type: 'error', error: err instanceof Error ? err.message : String(err) })
      await appendEvent(job.id, { type: 'done' })
      return
    }

    const proc = spawn('codex', codexArgs, processTreeSpawnOptions({
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    }))

    bindJobProcess(job, proc)

    const pendingSnapshots = new Map()
    const aggregatedFileChanges = new Map()
    const exploreEntries = []
    let editsStarted = false
    let exploreStarted = false
    let commandSeq = 0
    let checkpointFailure = null
    let pendingStdout = ''
    let stdoutChain = Promise.resolve()
    let stderrBuf = ''
    let exitCode = null
    let procError = null
    let providerSessionId = typeof request.sessionId === 'string'
      ? request.sessionId.trim() || null
      : null
    let sawProviderAcceptance = false

    const handleCodexJsonEvent = async (evt) => {
      if (!evt || typeof evt !== 'object') return
      if (evt.type === 'thread.started' && typeof evt.thread_id === 'string') {
        providerSessionId = evt.thread_id.trim() || providerSessionId
        await appendEvent(job.id, { type: 'session', sessionId: evt.thread_id })
        return
      }
      if (checkpointFailure) return

      if (
        evt.type === 'turn.started'
        || evt.type === 'turn.completed'
        || evt.type === 'item.started'
        || evt.type === 'item.completed'
      ) {
        sawProviderAcceptance = true
      }

      if (evt.type === 'item.started') {
        const item = evt.item
        if (item?.type === 'file_change' && Array.isArray(item.changes)) {
          const checkpointPaths = extractCodexCheckpointPaths(item.changes, workspaceDir)
          if (item.changes.length > 0 && checkpointPaths.length === 0) {
            checkpointFailure = 'no checkpointable file paths were provided by Codex file_change'
            await appendEvent(job.id, {
              type: 'error',
              error: `Checkpoint creation failed before Codex file change: ${checkpointFailure}`,
            })
            const termination = await job.cancel()
            if (!termination.confirmed) {
              await appendEvent(job.id, {
                type: 'error',
                error: `Codex process-tree termination failed: ${termination.detail}`,
              })
            }
            return
          }
          const checkpoint = await createDaemonCheckpoint(job, request, 'Codex file change', checkpointPaths, {
            itemType: 'file_change',
          })
          if (!checkpoint.ok) {
            checkpointFailure = checkpoint.error ?? 'unknown error'
            await appendEvent(job.id, {
              type: 'error',
              error: `Checkpoint creation failed before Codex file change: ${checkpointFailure}`,
            })
            const termination = await job.cancel()
            if (!termination.confirmed) {
              await appendEvent(job.id, {
                type: 'error',
                error: `Codex process-tree termination failed: ${termination.detail}`,
              })
            }
            return
          }

          for (const change of item.changes) {
            if (typeof change?.path !== 'string') continue
            const resolvedPath = resolveCodexFilePath(change.path, workspaceDir)
            const snapshot = await readSnapshotContent(resolvedPath)
            pendingSnapshots.set(resolvedPath, {
              displayPath: getDisplayPath(resolvedPath, workspaceDir),
              changeType: changeTypeFromCodexKind(change.kind),
              existed: snapshot.existed,
              content: snapshot.content,
            })
          }
        }
        return
      }

      if (evt.type !== 'item.completed') return
      const item = evt.item
      if (!item || typeof item !== 'object') return

      if (item.type === 'agent_message' && typeof item.text === 'string' && item.text) {
        await appendEvent(job.id, { type: 'text', text: item.text })
        return
      }

      if (item.type === 'command_execution' && typeof item.command === 'string') {
        const command = normalizeCodexShellCommand(item.command)
        const kind = classifyCodexCommand(command)
        const MAX_CMD_OUTPUT = 64 * 1024
        const rawOutput = sanitizeToolOutputText(typeof item.aggregated_output === 'string' ? item.aggregated_output : '')
        const output = rawOutput.length > MAX_CMD_OUTPUT
          ? rawOutput.slice(0, MAX_CMD_OUTPUT) + '\n…[truncated]'
          : rawOutput
        if (kind === 'search' || kind === 'read') {
          if (!exploreStarted) {
            await appendEvent(job.id, { type: 'tool_start', toolId: 'codex-explore', toolName: 'Exploring workspace' })
            exploreStarted = true
          }
          exploreEntries.push({ label: command, command, output, kind })
          await appendEvent(job.id, {
            type: 'tool_summary',
            toolId: 'codex-explore',
            toolName: buildExploreToolName(exploreEntries),
            commandEntries: [...exploreEntries],
          })
        } else {
          // kind === 'command' — surface as its own tool block instead of
          // dropping it, so build/test/publish/dev-server steps appear inline
          // between the assistant's narration text in chronological order.
          // Each command gets a unique toolId so blocks interleave with text
          // rather than collapsing into a single aggregate chip.
          const toolId = `codex-cmd-${commandSeq++}`
          await appendEvent(job.id, { type: 'tool_start', toolId, toolName: 'exec_command' })
          await appendEvent(job.id, {
            type: 'tool_summary',
            toolId,
            toolName: 'exec_command',
            commandEntries: [{ label: command, command, output, kind: 'command' }],
          })
        }
        return
      }

      if (item.type === 'file_change' && Array.isArray(item.changes)) {
        const fileChanges = await summarizeCodexFileChanges(item.changes, pendingSnapshots, workspaceDir)
        if (fileChanges.length === 0) return
        for (const change of fileChanges) {
          const key = `${change.path}::${change.previousPath ?? ''}::${change.changeType}`
          aggregatedFileChanges.set(key, change)
        }
        const merged = Array.from(aggregatedFileChanges.values())
        if (!editsStarted) {
          await appendEvent(job.id, {
            type: 'tool_start',
            toolId: 'codex-file-changes',
            toolName: buildEditedToolName(merged),
          })
          editsStarted = true
        }
        await appendEvent(job.id, {
          type: 'tool_summary',
          toolId: 'codex-file-changes',
          toolName: buildEditedToolName(merged),
          fileChanges: merged,
        })
      }
    }

    proc.stdout?.on('data', (chunk) => {
      pendingStdout += chunk.toString()
      const lines = pendingStdout.split(/\r?\n/)
      pendingStdout = lines.pop() ?? ''
      stdoutChain = stdoutChain.then(async () => {
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            await handleCodexJsonEvent(JSON.parse(trimmed))
          } catch {
            await appendEvent(job.id, { type: 'text', text: `${line}\n` })
          }
        }
      }).catch(() => {})
    })

    proc.stderr?.on('data', (chunk) => {
      stderrBuf += chunk.toString()
    })

    await new Promise((resolveJob) => {
      proc.on('close', (code) => {
        exitCode = code
        resolveJob()
      })
      proc.on('error', (error) => {
        procError = error
        resolveJob()
      })
    })

    const processTreeExit = await job.cancel()
    if (!processTreeExit.confirmed) {
      await appendEvent(job.id, {
        type: 'error',
        error: `Codex process-tree exit could not be confirmed: ${processTreeExit.detail}`,
      })
      return
    }

    await stdoutChain.catch(() => {})
    if (pendingStdout.trim()) {
      try {
        await handleCodexJsonEvent(JSON.parse(pendingStdout.trim()))
      } catch {
        await appendEvent(job.id, { type: 'text', text: pendingStdout })
      }
    }
    const stderrText = sanitizeCodexStderrText(stderrBuf)
    if (procError instanceof Error) {
      await appendEvent(job.id, { type: 'error', error: procError.message })
    } else if (stderrText) {
      await appendEvent(job.id, { type: 'error', error: stderrText })
    } else if (typeof exitCode === 'number' && exitCode !== 0) {
      await appendEvent(job.id, { type: 'error', error: `Codex exited with code ${exitCode}` })
    }
    stableSessionContexts.completeCli(stableContext, {
      exitCode,
      sawProviderAcceptance,
      providerError: procError instanceof Error
        || Boolean(checkpointFailure)
        || Boolean(stderrText)
        || job.cancelRequested,
      sessionId: providerSessionId,
    })
    await appendEvent(job.id, { type: 'done' })
  }

  async function runHermesJob(job, request, workspaceDir, instructionPrompt) {
    const lastUserMsg = [...(request.messages ?? [])].reverse().find(message => message.role === 'user')
    if (!lastUserMsg) {
      await appendEvent(job.id, { type: 'error', error: 'No user message' })
      await appendEvent(job.id, { type: 'done' })
      return
    }

    const prompt = buildCodexPrompt(lastUserMsg.content, contextPromptForRequest(request))
    const proc = spawn('hermes', buildHermesChatArgs({
      prompt,
      model: request.model,
      provider: request.providerId ?? request.modelProvider ?? request.providerName,
      toolsets: hermesToolsetsForRequest(request),
      resumeSessionId: request.sessionId,
      ignoreRules: Boolean(contextPromptForRequest(request) || request.contextBuckets),
      bypassPermissions: request.mode === 'bypassPermissions',
    }), processTreeSpawnOptions({
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      ...(workspaceDir ? { cwd: workspaceDir } : {}),
    }))

    bindJobProcess(job, proc)

    let stdoutBuf = ''
    let stderrBuf = ''
    let pendingLine = ''
    let jsonEventCount = 0
    let accumulatedThinking = ''
    let accumulatedText = ''
    let thinkingOpen = false
    let eventQueue = Promise.resolve()
    let exitCode = null
    let procError = null

    const closeThinking = async () => {
      if (!thinkingOpen) return
      thinkingOpen = false
      await appendEvent(job.id, { type: 'block_stop' })
    }

    const handleHermesEvent = async (evt) => {
      if (!evt || typeof evt !== 'object' || typeof evt.type !== 'string') return
      jsonEventCount += 1
      switch (evt.type) {
        case 'session':
          if (typeof evt.sessionId === 'string' && evt.sessionId.trim()) {
            await appendEvent(job.id, { type: 'session', sessionId: evt.sessionId.trim() })
          }
          break
        case 'thinking': {
          if (typeof evt.text !== 'string' || !evt.text) break
          const tail = remainingAssistantSnapshotText(evt.text, accumulatedThinking, accumulatedThinking)
          if (!tail) break
          if (!thinkingOpen) {
            thinkingOpen = true
            await appendEvent(job.id, { type: 'thinking_start', thinkingId: 'think-hermes-0' })
          }
          accumulatedThinking += tail
          await appendEvent(job.id, { type: 'thinking', text: tail, thinkingId: 'think-hermes-0' })
          break
        }
        case 'text': {
          if (typeof evt.text !== 'string' || !evt.text) break
          await closeThinking()
          const tail = remainingAssistantSnapshotText(evt.text, accumulatedText, accumulatedText)
          if (!tail) break
          accumulatedText += tail
          await appendEvent(job.id, { type: 'text', text: tail })
          break
        }
        case 'tool_start':
          await closeThinking()
          await appendEvent(job.id, {
            type: 'tool_start',
            toolId: typeof evt.toolId === 'string' ? evt.toolId : undefined,
            toolName: typeof evt.toolName === 'string' ? evt.toolName : 'tool',
          })
          break
        case 'tool_input':
          await appendEvent(job.id, {
            type: 'tool_input',
            toolId: typeof evt.toolId === 'string' ? evt.toolId : undefined,
            text: typeof evt.text === 'string' ? evt.text : '',
          })
          break
        case 'tool_summary':
          await appendEvent(job.id, {
            type: 'tool_summary',
            toolId: typeof evt.toolId === 'string' ? evt.toolId : undefined,
            toolName: typeof evt.toolName === 'string' ? evt.toolName : undefined,
            text: typeof evt.text === 'string' ? evt.text : '',
          })
          break
        case 'error':
          await closeThinking()
          await appendEvent(job.id, {
            type: 'error',
            error: typeof evt.error === 'string' ? evt.error : 'Unknown Hermes error',
          })
          break
        default:
          break
      }
    }

    const consumeStdout = (chunk, flushPartial) => {
      pendingLine += chunk
      const lines = pendingLine.split(/\r?\n/)
      pendingLine = flushPartial ? '' : (lines.pop() ?? '')
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        stdoutBuf += `${line}\n`
        let evt = null
        try { evt = JSON.parse(trimmed) } catch { continue }
        eventQueue = eventQueue.then(() => handleHermesEvent(evt)).catch(() => {})
      }
    }

    proc.stdout?.on('data', (chunk) => {
      consumeStdout(chunk.toString(), false)
    })
    proc.stderr?.on('data', (chunk) => {
      stderrBuf += chunk.toString()
    })

    await new Promise((resolveJob) => {
      proc.on('close', (code) => {
        exitCode = code
        resolveJob()
      })
      proc.on('error', (error) => {
        procError = error
        resolveJob()
      })
    })
    consumeStdout('', true)
    await eventQueue
    await closeThinking()

    const processTreeExit = await job.cancel()
    if (!processTreeExit.confirmed) {
      await appendEvent(job.id, {
        type: 'error',
        error: `Hermes process-tree exit could not be confirmed: ${processTreeExit.detail}`,
      })
      return
    }

    if (procError instanceof Error) {
      await appendEvent(job.id, { type: 'error', error: sanitizeAgentCliDiagnostic(procError.message) })
    } else if (typeof exitCode === 'number' && exitCode !== 0) {
      const diagnostic = stderrBuf.trim() || stdoutBuf.trim() || `Hermes exited with code ${exitCode}`
      await appendEvent(job.id, { type: 'error', error: sanitizeAgentCliDiagnostic(diagnostic) })
    } else if (jsonEventCount === 0) {
      const parsed = parseHermesOutput(stdoutBuf)
      if (parsed.sessionId) await appendEvent(job.id, { type: 'session', sessionId: parsed.sessionId })
      if (parsed.text) await appendEvent(job.id, { type: 'text', text: parsed.text })
    }

    await appendEvent(job.id, { type: 'done' })
  }

  async function runOpenCodeJob(job, request, workspaceDir, instructionPrompt) {
    const lastUserMsg = [...(request.messages ?? [])].reverse().find(message => message.role === 'user')
    if (!lastUserMsg) {
      await appendEvent(job.id, { type: 'error', error: 'No user message' })
      await appendEvent(job.id, { type: 'done' })
      return
    }

    const prompt = buildCodexPrompt(lastUserMsg.content, contextPromptForRequest(request))
    const agent = typeof request.agent === 'string'
      ? request.agent
      : typeof request.agentName === 'string'
        ? request.agentName
        : typeof request.metadata?.agent === 'string'
          ? request.metadata.agent
          : null
    const proc = spawn('opencode', buildOpenCodeRunArgs({
      prompt,
      model: request.model,
      agent,
      sessionId: request.sessionId,
      cwd: workspaceDir,
      bypassPermissions: request.mode === 'bypassPermissions',
    }), processTreeSpawnOptions({
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    }))

    bindJobProcess(job, proc)

    const emittedSessionIds = new Set()
    const fallbackTextParts = []
    let pendingStdout = ''
    let stdoutChain = Promise.resolve()
    let stderrBuf = ''
    let exitCode = null
    let procError = null

    const handleOpenCodeJsonEvent = async (evt) => {
      if (!evt || typeof evt !== 'object') return
      const sessionId = extractAgentSessionId(evt)
      if (sessionId && !emittedSessionIds.has(sessionId)) {
        emittedSessionIds.add(sessionId)
        await appendEvent(job.id, { type: 'session', sessionId })
      }

      const text = extractOpenCodeTextPayload(evt)
      if (text) await appendEvent(job.id, { type: 'text', text })
    }

    const processOpenCodeLine = async (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      try {
        await handleOpenCodeJsonEvent(JSON.parse(trimmed))
      } catch {
        fallbackTextParts.push(line)
      }
    }

    proc.stdout?.on('data', (chunk) => {
      pendingStdout += chunk.toString()
      const lines = pendingStdout.split(/\r?\n/)
      pendingStdout = lines.pop() ?? ''
      stdoutChain = stdoutChain.then(async () => {
        for (const line of lines) await processOpenCodeLine(line)
      }).catch(() => {})
    })

    proc.stderr?.on('data', (chunk) => {
      stderrBuf += chunk.toString()
    })

    await new Promise((resolveJob) => {
      proc.on('close', (code) => {
        exitCode = code
        resolveJob()
      })
      proc.on('error', (error) => {
        procError = error
        resolveJob()
      })
    })

    const processTreeExit = await job.cancel()
    if (!processTreeExit.confirmed) {
      await appendEvent(job.id, {
        type: 'error',
        error: `OpenCode process-tree exit could not be confirmed: ${processTreeExit.detail}`,
      })
      return
    }

    await stdoutChain.catch(() => {})
    if (pendingStdout.trim()) {
      await processOpenCodeLine(pendingStdout)
    }

    if (procError instanceof Error) {
      await appendEvent(job.id, { type: 'error', error: sanitizeAgentCliDiagnostic(procError.message) })
    } else if (typeof exitCode === 'number' && exitCode !== 0) {
      const diagnostic = stderrBuf.trim() || fallbackTextParts.join('\n').trim() || `OpenCode exited with code ${exitCode}`
      await appendEvent(job.id, { type: 'error', error: sanitizeAgentCliDiagnostic(diagnostic) })
    } else if (fallbackTextParts.length > 0) {
      await appendEvent(job.id, { type: 'text', text: fallbackTextParts.join('\n').trim() })
    }

    await appendEvent(job.id, { type: 'done' })
  }

  async function runOmnigentJob(job, request, workspaceDir, instructionPrompt) {
    const lastUserMsg = [...(request.messages ?? [])].reverse().find(message => message.role === 'user')
    if (!lastUserMsg) {
      await appendEvent(job.id, { type: 'error', error: 'No user message' })
      await appendEvent(job.id, { type: 'done' })
      return
    }

    // Daemon-resolved settings (codesurfd folds settings.json + env overrides
    // into request.omnigent). Fall back to defaults so the cloud clone — which
    // has no settings.json — still works against a local backend.
    const settings = request.omnigent && typeof request.omnigent === 'object' ? request.omnigent : {}
    if (settings.enabled === false) {
      await appendEvent(job.id, { type: 'error', error: 'Omnigent provider is disabled in daemon settings (settings.omnigent.enabled = false).' })
      await appendEvent(job.id, { type: 'done' })
      return
    }
    const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey : ''
    let baseUrl = normalizeOmnigentServerRoot(
      typeof settings.baseUrl === 'string' && settings.baseUrl.trim() ? settings.baseUrl : OMNIGENT_DEFAULT_BASE_URL,
    )

    const prompt = buildCodexPrompt(
      lastUserMsg.content ?? '',
      contextPromptForRequest(request),
    )

    const abortController = new AbortController()
    job.cancel = () => { try { abortController.abort() } catch {} }

    // Bound the whole turn: the live SSE tail never closes per turn, so a stalled
    // backend would otherwise hang here forever. A timeout aborts the stream and
    // every in-flight fetch via the shared controller; timedOut distinguishes it
    // from a user cancel (cancel is silent, timeout surfaces an error).
    let timedOut = false
    const turnTimeout = setTimeout(() => {
      timedOut = true
      try { abortController.abort() } catch {}
    }, OMNIGENT_TURN_TIMEOUT_MS)

    // Lazy tool_start: the typed-event table only guarantees output_item.done,
    // so we may first see a tool on .done — emit its start then, keyed (like the
    // result) on call_id so the result block attaches to the call block.
    const startedToolIds = new Set()
    const emittedSessionIds = new Set()

    const emitSession = async (sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId.trim()) return
      const normalized = sessionId.trim()
      if (emittedSessionIds.has(normalized)) return
      emittedSessionIds.add(normalized)
      await appendEvent(job.id, { type: 'session', sessionId: normalized })
    }

    const ensureToolStart = async (toolId, toolName) => {
      if (startedToolIds.has(toolId)) return
      startedToolIds.add(toolId)
      await appendEvent(job.id, { type: 'tool_start', toolId, toolName })
    }

    // Pair thinking_start with a block_stop. The client's reducer leaves a
    // thinking block open until block_stop (it is never closed by `done`), so an
    // unpaired thinking_start renders a perpetually-open reasoning indicator. We
    // close it on the first non-reasoning event — and ALWAYS before starting any
    // tool, because block_stop also marks the last running tool block done.
    let thinkingOpen = false
    const closeThinking = async () => {
      if (!thinkingOpen) return
      thinkingOpen = false
      await appendEvent(job.id, { type: 'block_stop' })
    }

    // Apply a mapped descriptor; returns 'done' | 'error' for terminals.
    const applyDescriptor = async (descriptor) => {
      if (!descriptor) return null
      switch (descriptor.kind) {
        case 'text':
          await closeThinking()
          await appendEvent(job.id, { type: 'text', text: descriptor.text })
          return null
        case 'thinking':
          await appendEvent(job.id, { type: 'thinking', text: descriptor.text })
          return null
        case 'thinking_start':
          thinkingOpen = true
          await appendEvent(job.id, { type: 'thinking_start' })
          return null
        case 'tool_call':
          await closeThinking()
          await ensureToolStart(descriptor.toolId, descriptor.toolName)
          if (descriptor.toolInput != null) {
            await appendEvent(job.id, {
              type: 'tool_use',
              toolName: descriptor.toolName,
              toolId: descriptor.toolId,
              toolInput: descriptor.toolInput,
            })
          }
          return null
        case 'tool_result':
          await closeThinking()
          await ensureToolStart(descriptor.toolId, 'tool')
          await appendEvent(job.id, { type: 'tool_summary', toolId: descriptor.toolId, text: descriptor.output })
          return null
        case 'terminal':
          await closeThinking()
          if (descriptor.stop === 'error') {
            await appendEvent(job.id, { type: 'error', error: sanitizeAgentCliDiagnostic(descriptor.error ?? 'Omnigent turn failed.') })
            return 'error'
          }
          return 'done'
        default:
          return null
      }
    }

    try {
      // Auto-start the local omni server when enabled. Idempotent: a running
      // server reports its live URL. Best effort — fall through to the
      // configured base URL and let the stream fetch surface a clear error.
      // Only autostart when the base URL is still the local default — a
      // configured remote endpoint always wins (mirrors the CLI's ensureBaseUrl,
      // which only starts the local server when no base URL is set).
      if (settings.autoStart !== false && baseUrl === OMNIGENT_DEFAULT_BASE_URL) {
        try {
          const started = await startLocalOmnigentServer(OMNIGENT_DEFAULT_CLI, abortController.signal)
          if (started) baseUrl = started
        } catch {}
      }

      // Resume reuses the prior Omnigent session id (echoed back as
      // request.sessionId); a fresh turn creates a new persistent session.
      let sessionId = typeof request.sessionId === 'string' && request.sessionId.trim() ? request.sessionId.trim() : null
      if (!sessionId) {
        const agentId = await resolveOmnigentAgentId(request.model, settings, baseUrl, apiKey, abortController.signal)
        // Bind the session to a runner host. Required: a session created without
        // host_id never gets a runner bound, so its turns fail with
        // runner_unavailable. Resolved before create so a missing host fails the
        // job cleanly here instead of mid-turn.
        const hostId = await resolveOmnigentHostId(settings, baseUrl, apiKey, abortController.signal)
        const body = buildOmnigentSessionBody({
          agentId,
          hostId,
          title: omnigentTitleFromPrompt(lastUserMsg.content ?? ''),
          workspace: workspaceDir,
        })
        const created = await omnigentFetchJson(baseUrl, '/v1/sessions', apiKey, {
          method: 'POST',
          body: JSON.stringify(body),
          signal: abortController.signal,
        })
        sessionId = extractOmnigentSessionId(created)
        if (!sessionId) throw new Error('Omnigent session create response did not include an id.')
      }
      await emitSession(sessionId)

      // Live-tail SSE: no replay, stays open across turns. Subscribe FIRST, then
      // POST the user turn so no events fire in the gap (API.md Reconnect Contract).
      const streamResponse = await fetch(
        omnigentEndpointUrl(baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/stream`),
        {
          method: 'GET',
          headers: { Accept: 'text/event-stream', ...omnigentAuthHeaders(apiKey) },
          signal: abortController.signal,
        },
      )
      if (!streamResponse.ok || !streamResponse.body) {
        const text = await streamResponse.text().catch(() => '')
        throw new Error(text || `Omnigent stream returned HTTP ${streamResponse.status}`)
      }

      await omnigentFetchJson(baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/events`, apiKey, {
        method: 'POST',
        body: JSON.stringify({ type: 'message', data: { role: 'user', content: [{ type: 'input_text', text: prompt }] } }),
        signal: abortController.signal,
      })

      // Read the tail and STOP only on a terminal response.* event — the stream
      // does not close or emit [DONE] when a single turn completes, so EOF and
      // [DONE] are NOT success: if either arrives before a terminal event the
      // turn was truncated, which we surface as an error (not a silent done).
      // This is the load-bearing difference from the codex/hermes runners.
      const reader = streamResponse.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let sawTerminal = false
      try {
        while (!sawTerminal) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf('\n\n')
          let streamEnded = false
          while (boundary >= 0) {
            const chunk = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const { eventName, data } = parseOmnigentSseChunk(chunk)
            if (data === '[DONE]') { streamEnded = true; break }
            if (data) {
              let parsed
              try {
                parsed = JSON.parse(data)
              } catch {
                parsed = null
              }
              if (parsed && typeof parsed === 'object') {
                if (eventName && typeof parsed.type !== 'string') parsed.type = eventName
                const result = await applyDescriptor(mapOmnigentStreamEvent(parsed))
                if (result === 'done' || result === 'error') { sawTerminal = true; break }
              }
            }
            boundary = buffer.indexOf('\n\n')
          }
          if (streamEnded) break
        }
      } finally {
        try { await reader.cancel() } catch {}
      }

      // EOF / [DONE] reached without a terminal response.* event => truncated.
      if (!sawTerminal && !abortController.signal.aborted) {
        await appendEvent(job.id, { type: 'error', error: 'Omnigent stream ended before the turn completed (truncated stream).' })
      }
    } catch (err) {
      if (timedOut) {
        await appendEvent(job.id, { type: 'error', error: `Omnigent turn timed out after ${Math.round(OMNIGENT_TURN_TIMEOUT_MS / 1000)}s.` })
      } else if (!abortController.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err)
        await appendEvent(job.id, { type: 'error', error: sanitizeAgentCliDiagnostic(message) })
      }
    } finally {
      clearTimeout(turnTimeout)
      // Best-effort remote interrupt when the turn was aborted locally (user
      // cancel or the turn timeout) — the turn is still running server-side.
      if (abortController.signal.aborted) {
        const cancelledSessionId = emittedSessionIds.values().next().value
        if (cancelledSessionId) {
          try {
            await fetch(omnigentEndpointUrl(baseUrl, `/v1/sessions/${encodeURIComponent(cancelledSessionId)}/events`), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...omnigentAuthHeaders(apiKey) },
              body: JSON.stringify({ type: 'interrupt', data: {} }),
              signal: AbortSignal.timeout(2_000),
            })
          } catch {}
        }
      }
    }

    await appendEvent(job.id, { type: 'done' })
  }

  async function runJob(job, request, workspaceDir) {
    try {
      if (job.cancelRequested) return
      // PRE-START authoritative resolution (#cli-persona). A caller may supply only
      // an `agentId` and NO `agentMode` — the `codesurf chat --persona` CLI does
      // exactly this on purpose: it NEVER constructs a trusted agentMode, it sends
      // the persona id and lets the daemon resolve tools/permissions from trusted
      // local sources. When agentMode is ABSENT we resolve it here, BEFORE the
      // fail-closed unresolved check below, so an agentId-only request works instead
      // of always failing closed. Resolution is fail-closed itself: ENOENT (no
      // agents.json) → BUILT-INS authoritative; present file → agents.json overlay;
      // corrupt/unknown id → refuse. Crucially the tools/permissions come ONLY from
      // these trusted sources, never from any caller-supplied payload.
      //
      // This does NOT touch the agentMode-PRESENT paths: the GUI ships a re-resolved
      // agentMode (overridden below when a local agents.json exists), and the cloud
      // clone (no `.codesurf`) trusts the caller's shipped agentMode. The CLI sends no
      // agentMode, so it can only reach THIS branch — the trust path stays intact.
      if (request.agentId && request.agentMode == null) {
        const preStart = await resolveAuthoritativeAgentMode({
          agentId: request.agentId,
          resolveWorkspaceRoot: () => workspaceDir,
        })
        if (job.cancelRequested) return
        if (!preStart.ok) {
          await appendEvent(job.id, { type: 'error', error: preStart.error })
          await appendEvent(job.id, { type: 'done' })
          return
        }
        request = { ...request, agentMode: preStart.agentMode }
      }

      // A-PR1 BLOCKING-1 (security chokepoint): a selected agent whose definition
      // has not resolved must not launch unrestricted. This guard covers EVERY
      // daemon provider (claude SDK / codex / hermes / opencode / harness) in one
      // place — providers downstream enforce persona + tools from request.agentMode,
      // so a dangling agentId without agentMode would silently bypass them.
      if (agentModeUnresolved(request)) {
        await appendEvent(job.id, { type: 'error', error: AGENT_MODE_UNRESOLVED_ERROR })
        await appendEvent(job.id, { type: 'done' })
        return
      }

      // Defense-in-depth (ROOT FIX). Main already resolved the agentId
      // authoritatively and shipped the agentMode, but the LOCAL daemon shares the
      // filesystem with main, so when a real agents.json is present we RE-RESOLVE
      // from the trusted workspaceDir and override — a second, independent
      // enforcement of the same source of truth. The remote/cloud daemon has no
      // `.codesurf` (the gitignored dir is excluded from the clone) → the file is
      // absent → we trust the agentMode main resolved and shipped (the only
      // authority the cloud has). Gating on file existence is what keeps cloud
      // working: re-resolving a custom agentId with no local file would otherwise
      // fail closed and clobber main's correct value.
      if (request.agentId && workspaceDir &&
          existsSync(join(workspaceDir, '.codesurf', 'customisation', 'agents.json'))) {
        const authoritative = await resolveAuthoritativeAgentMode({
          agentId: request.agentId,
          resolveWorkspaceRoot: () => workspaceDir,
        })
        if (job.cancelRequested) return
        if (!authoritative.ok) {
          await appendEvent(job.id, { type: 'error', error: authoritative.error })
          await appendEvent(job.id, { type: 'done' })
          return
        }
        request = { ...request, agentMode: authoritative.agentMode }
      }

      // Treat every caller-provided context field as untrusted at the daemon
      // boundary. Main-process validation is useful UX, but remote callers and
      // older clients can bypass it; provider builders only see this copy.
      const contextValidation = revalidateDaemonContextRequest(request)
      request = contextValidation.request

      const callerMemoryPrompt = String(request.memoryPrompt ?? '').trim()
      let memoryContext = null
      if (!callerMemoryPrompt) {
        memoryContext = await loadMemoryContext({
          homeDir,
          workspaceDir,
          projectPaths: [workspaceDir],
          executionTarget: request.executionTarget ?? 'local',
        })
        if (job.cancelRequested) return
      }
      const instructionPrompt = callerMemoryPrompt || buildMemoryPrompt(memoryContext)
      const suppliedContext = request.contextBuckets ?? memoryContext
      const contextBuckets = buildContextBucketBundle(suppliedContext, instructionPrompt)
      const suppliedContextSummary = String(suppliedContext?.inspect?.summary ?? '').trim()
      if (suppliedContextSummary && contextBuckets.inspect) {
        contextBuckets.inspect.summary = suppliedContextSummary
      }
      const baseMemorySummary = summarizeMemoryContext(contextBuckets, instructionPrompt)
      const unboundedMemorySummary = contextValidation.metadata.memoryPrompt.truncated
        ? `${baseMemorySummary || 'Loaded workspace instructions for this run.'}; caller-provided prompt was truncated by the daemon context budget`
        : baseMemorySummary
      const memorySummary = unboundedMemorySummary
        ? truncateUtf8(unboundedMemorySummary, MAX_SKILLS_SUMMARY_BYTES, {
            reason: `maximum context summary bytes (${MAX_SKILLS_SUMMARY_BYTES})`,
          }).text
        : undefined
      const memoryInput = buildMemoryContextInput(contextBuckets, instructionPrompt)
      const announcementScope = {
        workspaceId: request.workspaceId,
        cardId: request.cardId,
        sessionId: request.sessionId,
      }
      if (memorySummary && stableContextAnnouncements.consume({
        ...announcementScope,
        kind: 'memory',
        content: `${memorySummary}\n${memoryInput ?? ''}`,
      })) {
        await appendEvent(job.id, {
          type: 'tool_start',
          toolId: 'codesurf-memory-context',
          toolName: 'Workspace Instructions',
        })
        if (memoryInput) {
          const preview = previewContextToolInput(memoryInput)
          await appendEvent(job.id, {
            type: 'tool_input',
            toolId: 'codesurf-memory-context',
            text: preview.text,
          })
        }
        await appendEvent(job.id, {
          type: 'tool_summary',
          toolId: 'codesurf-memory-context',
          toolName: 'Workspace Instructions',
          text: memorySummary,
        })
      }

      const baseSkillsSummary = String(request.skillsSummary ?? '').trim()
      const skillsPrompt = String(request.skillsPrompt ?? '').trim()
      const unboundedSkillsSummary = contextValidation.metadata.skillsPrompt.truncated
        ? `${baseSkillsSummary || 'Included skills context for this run.'}; caller-provided prompt was truncated by the daemon context budget`
        : baseSkillsSummary || (skillsPrompt ? 'Included skills context for this run.' : '')
      const skillsSummary = unboundedSkillsSummary
        ? truncateUtf8(unboundedSkillsSummary, MAX_SKILLS_SUMMARY_BYTES, {
            reason: `maximum skills summary bytes (${MAX_SKILLS_SUMMARY_BYTES})`,
          }).text
        : ''
      if (skillsSummary && stableContextAnnouncements.consume({
        ...announcementScope,
        kind: 'skills',
        content: `${skillsSummary}\n${skillsPrompt}`,
      })) {
        await appendEvent(job.id, {
          type: 'tool_start',
          toolId: 'codesurf-skills-context',
          toolName: 'Included Skills',
        })
        if (skillsPrompt) {
          const preview = previewContextToolInput(skillsPrompt)
          await appendEvent(job.id, {
            type: 'tool_input',
            toolId: 'codesurf-skills-context',
            text: preview.text,
          })
        }
        await appendEvent(job.id, {
          type: 'tool_summary',
          toolId: 'codesurf-skills-context',
          toolName: 'Included Skills',
          text: skillsSummary,
        })
      }

      // Codex is deliberately EXCLUDED from the harness path even when the
      // harness is enabled (A-PR1 #2c / honest-notes): the @ai-sdk/harness-codex
      // adapter cannot honor CodeSurf's 4 permission modes — it throws on any
      // non-'allow-all' permissionMode and its bridge hardcodes
      // sandboxMode:'danger-full-access' + approvalPolicy:'never'. Routing Codex
      // through it would either crash or silently grant full access regardless
      // of the user's chosen mode. The native `codex exec` CLI (runCodexJob)
      // honors all 4 modes via -s/--sandbox + -c approval_policy=, so Codex
      // always uses it. Tradeoff: Codex forgoes the harness's worktree isolation.
      //
      // shouldUseHarness() also excludes FOREGROUND Claude chat (continuity
      // stopgap) so those turns fall through to runClaudeJob, which resumes the
      // conversation — see the predicate's comment for the full rationale.
      if (shouldUseHarness(request)) {
        const { runHarnessJob } = await getHarnessRunner()
        if (job.cancelRequested) return
        await runHarnessJob(job, request, workspaceDir, instructionPrompt, {
          appendEvent,
          createCheckpoint: (toolName, filePaths) => createDaemonCheckpoint(job, request, toolName, filePaths),
          awaitToolPermission: (toolUseID, permissionRequest) => awaitToolPermissionAnswer(job, toolUseID, permissionRequest),
          contextPrompt: contextPromptForRequest(request),
        })
      } else if (request.provider === 'claude') {
        await runClaudeJob(job, request, workspaceDir, instructionPrompt)
      } else if (request.provider === 'codex') {
        await runCodexJob(job, request, workspaceDir, instructionPrompt)
      } else if (request.provider === 'opencode') {
        await runOpenCodeJob(job, request, workspaceDir, instructionPrompt)
      } else if (request.provider === 'hermes') {
        await runHermesJob(job, request, workspaceDir, instructionPrompt)
      } else if (request.provider === 'omnigent') {
        await runOmnigentJob(job, request, workspaceDir, instructionPrompt)
      } else if (request.provider === 'gateway') {
        const { runGatewayJob } = await import('./gateway-provider.mjs')
        if (job.cancelRequested) return
        await runGatewayJob(job, request, workspaceDir, instructionPrompt, {
          appendEvent,
          contextPrompt: contextPromptForRequest(request),
        })
      } else if (request.provider === 'pi') {
        await appendEvent(job.id, { type: 'error', error: PI_HARNESS_UNAVAILABLE_ERROR })
        await appendEvent(job.id, { type: 'done' })
      } else {
        await appendEvent(job.id, { type: 'error', error: `Daemon execution is only implemented for Claude, Codex, OpenCode, Hermes, Omnigent, and AI Gateway right now. Requested: ${request.provider}` })
        await appendEvent(job.id, { type: 'done' })
      }
    } catch (err) {
      // Contain the failure to this job: emit terminal events so the client is
      // not left hanging, then let the finally block free the concurrency slot.
      console.error(`[chat-jobs] runJob error for job ${job.id}:`, err)
      if (isTimelinePersistenceError(err) || timelinePersistence.get(job.id)?.failed) {
        // failTimelinePersistence already stopped the provider and emitted one
        // bounded in-memory terminal pair. Retrying through appendEvent here
        // would only feed a known-bad persistence queue.
        return
      }
      try {
        await appendEvent(job.id, { type: 'error', error: err instanceof Error ? err.message : String(err) })
        await appendEvent(job.id, { type: 'done' })
      } catch (appendErr) {
        console.error(`[chat-jobs] failed to emit terminal events for job ${job.id}:`, appendErr)
      }
    } finally {
      job.runnerFinished = true
      // A failed tree termination is not a completed lifecycle. Retain the
      // owned PID/group so cancel or shutdown can retry instead of orphaning it.
      if (!job.cancelRequested && !job.terminationFailed) {
        liveJobs.delete(job.id)
        clearMetadataFlush(job.id)
      }
      const failedPersistence = timelinePersistence.get(job.id)
      if (failedPersistence?.failed) {
        void scheduleFailedRecordFinalization(failedPersistence)
      }
      enforceFailedTimelineRecordLimit()
      activeJobCount = Math.max(0, activeJobCount - 1)
      pumpJobQueue()
    }
  }

  // daemon-01: dispatch queued jobs while a concurrency slot is free. Called
  // after every enqueue (startJob) and every job completion (runJob finally).
  function pumpJobQueue() {
    // D3: shutdown terminalized the queue itself; never launch after it began.
    while (!closing && activeJobCount < MAX_CONCURRENT_JOBS && jobQueue.length > 0) {
      const next = jobQueue.shift()
      if (!next?.live || !liveJobs.has(next.live.id)) continue // cancelled while queued
      activeJobCount += 1
      if (next.live.metadata?.status === 'queued') {
        next.live.metadata.status = 'running'
        next.live.metadata.updatedAt = new Date().toISOString()
        void writeJobMetadata(next.live.metadata).catch(() => {})
      }
      const runPromise = runJob(next.live, next.request, next.workspaceDir)
      next.live.runPromise = runPromise
      void runPromise
    }
  }

  function normalizeStartRequestId(value) {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > START_REQUEST_ID_MAX_LENGTH) return null
    return trimmed
  }

  function rejectIfClosing() {
    if (closing) throw new Error('Daemon is shutting down')
  }

  // D1: idempotent start — a client retry after an unknown outcome (lost
  // response, timeout) sends the same startRequestId and coalesces onto the
  // job the first attempt created instead of executing the prompt twice.
  async function startJob(request) {
    rejectIfClosing()
    const startRequestId = normalizeStartRequestId(request?.startRequestId)
    if (!startRequestId) return await createJob(request)
    const existing = startRequestsById.get(startRequestId)
    if (existing) return await existing
    const pending = createJob(request)
    startRequestsById.set(startRequestId, pending)
    pending.catch(() => {
      if (startRequestsById.get(startRequestId) === pending) startRequestsById.delete(startRequestId)
    })
    while (startRequestsById.size > START_REQUEST_MEMORY) {
      const oldest = startRequestsById.keys().next().value
      if (oldest === undefined) break
      startRequestsById.delete(oldest)
    }
    return await pending
  }

  async function createJob(request) {
    const id = randomUUID()
    const effectiveProjectContext = applyProjectContextPolicy({
      executionTarget: request?.executionTarget,
      projectContext: request?.projectContext ?? { workspaceDir: request?.workspaceDir },
    })
    const workspaceDir = await ensureProvisionedWorkspace(homeDir, effectiveProjectContext)
    // D3: shutdown may have begun while the workspace was being provisioned.
    rejectIfClosing()
    const initialPrompt = extractTaskLabelFromRequest(request)
    // daemon-01: if every slot is busy, persist as 'queued' from the start so
    // the dashboard/getJobState reflect reality; pumpJobQueue flips it to
    // 'running' the moment a slot frees.
    const startStatus = activeJobCount >= MAX_CONCURRENT_JOBS ? 'queued' : 'running'
    const metadata = {
      id,
      taskLabel: initialPrompt,
      status: startStatus,
      provider: request.provider,
      model: request.model,
      // A-PR1 #2b: persist the chosen permission mode so reopening a session
      // restores it (read back in codesurfd.mjs reconstructSessionState).
      mode: typeof request.mode === 'string' ? request.mode : null,
      runMode: request.runMode === 'background' ? 'background' : 'foreground',
      workspaceId: typeof request.workspaceId === 'string' ? request.workspaceId : null,
      cardId: typeof request.cardId === 'string' ? request.cardId : null,
      workspaceDir,
      initialPrompt,
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      lastSequence: 0,
      sessionId: typeof request.sessionId === 'string' ? request.sessionId : null,
      error: null,
    }
    const live = {
      id,
      metadata,
      cancel: null,
      cancelPromise: null,
      cancelRequested: false,
      proc: null,
      processTerminationPromise: null,
      processTerminationResult: null,
      query: null,
      runnerFinished: false,
      runPromise: null,
      terminationFailed: false,
    }
    liveJobs.set(id, live)
    try {
      await writeJobMetadata(metadata)
      await fs.writeFile(jobTimelinePath(id), '', 'utf8')
    } catch (error) {
      liveJobs.delete(id)
      throw error
    }
    jobQueue.push({ live, request, workspaceDir })
    pumpJobQueue()
    return metadata
  }

  async function cancelJob(jobId) {
    const live = liveJobs.get(jobId)
    cancelPendingToolPermissionsForJob(jobId, 'Job cancelled')
    // daemon-01: a job still waiting in the queue has no live.cancel yet —
    // remove it from the queue and terminate it cleanly so it never starts.
    const queueIdx = jobQueue.findIndex(item => item.live?.id === jobId)
    if (queueIdx !== -1) {
      jobQueue.splice(queueIdx, 1)
      try {
        await appendEvent(jobId, { type: 'error', error: 'Job cancelled' })
        await appendEvent(jobId, { type: 'done' })
      } catch (error) {
        if (!isTimelinePersistenceError(error)) throw error
      } finally {
        liveJobs.delete(jobId)
        clearMetadataFlush(jobId)
        const failedPersistence = timelinePersistence.get(jobId)
        if (failedPersistence?.failed) {
          void scheduleFailedRecordFinalization(failedPersistence)
        }
        enforceFailedTimelineRecordLimit()
      }
      return { ok: true }
    }
    if (live?.cancel) {
      if (live.cancelPromise) return await live.cancelPromise
      live.cancelRequested = true
      const cancelPromise = (async () => {
        let termination
        try {
          termination = await live.cancel()
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          live.terminationFailed = true
          await appendEvent(jobId, {
            type: 'error',
            error: `Job cancellation failed: ${detail}`,
          }, { allowDuringCancellation: true })
          return { ok: false, error: `Job cancellation failed: ${detail}` }
        }
        if (termination && termination.confirmed === false) {
          live.terminationFailed = true
          const error = `Job cancellation failed: ${termination.detail}`
          await appendEvent(jobId, { type: 'error', error }, { allowDuringCancellation: true })
          return { ok: false, error }
        }

        const runnerSettled = await waitForJobRunnerSettlement(live)
        if (!runnerSettled) {
          live.terminationFailed = true
          const error = 'Job cancellation failed: provider runner did not settle after cancellation'
          await appendEvent(jobId, { type: 'error', error }, { allowDuringCancellation: true })
          return { ok: false, error }
        }

        live.terminationFailed = false
        await appendEvent(
          jobId,
          { type: 'error', error: 'Job cancelled' },
          { allowDuringCancellation: true },
        )
        await appendEvent(jobId, { type: 'done' }, { allowDuringCancellation: true })
        return { ok: true }
      })()
      live.cancelPromise = cancelPromise
      const result = await cancelPromise
      if (!result.ok && live.cancelPromise === cancelPromise) {
        live.cancelPromise = null
      }
      if (result.ok && live.runnerFinished && liveJobs.get(jobId) === live) {
        liveJobs.delete(jobId)
        clearMetadataFlush(jobId)
      }
      return result
    }
    if (live) {
      if (live.cancelPromise) return await live.cancelPromise
      live.cancelRequested = true
      const cancelPromise = (async () => {
        const runnerSettled = await waitForJobRunnerSettlement(live)
        if (!runnerSettled) {
          live.terminationFailed = true
          const error = 'Job cancellation failed: provider preparation did not settle after cancellation'
          await appendEvent(jobId, { type: 'error', error }, { allowDuringCancellation: true })
          return { ok: false, error }
        }
        live.terminationFailed = false
        await appendEvent(
          jobId,
          { type: 'error', error: 'Job cancelled' },
          { allowDuringCancellation: true },
        )
        await appendEvent(jobId, { type: 'done' }, { allowDuringCancellation: true })
        return { ok: true }
      })()
      live.cancelPromise = cancelPromise
      const result = await cancelPromise
      if (!result.ok && live.cancelPromise === cancelPromise) {
        live.cancelPromise = null
      }
      if (result.ok && live.runnerFinished && liveJobs.get(jobId) === live) {
        liveJobs.delete(jobId)
        clearMetadataFlush(jobId)
      }
      return result
    }
    return { ok: false, error: 'Job not running' }
  }

  async function getJobState(jobId) {
    const failedPersistence = timelinePersistence.get(jobId)
    const failedState = failedPersistence?.durableFailureMetadata
      ?? failedPersistence?.failureMetadata
    if (failedState) {
      return { ...failedState }
    }
    return await readJobMetadata(jobId)
  }

  function getPersistenceState(jobId) {
    const record = timelinePersistence.get(jobId)
    if (!record) {
      return {
        failed: false,
        queuedEvents: 0,
        queuedBytes: 0,
      }
    }
    return {
      failed: record.failed,
      queuedEvents: record.entries.length,
      queuedBytes: record.queuedBytes,
      ...(record.error ? { error: record.error.message } : {}),
    }
  }

  const INTERRUPTED_JOB_ERROR = 'Job was interrupted (the daemon restarted)'

  async function scanTimeline(jobId, {
    expectedSerialized = null,
    expectedSequence = null,
    onRecord = null,
  } = {}) {
    const timelinePath = jobTimelinePath(jobId)
    if (!existsSync(timelinePath)) {
      return {
        maxSequence: 0,
        terminalSeen: false,
        terminalSequence: null,
        terminalStartByte: null,
        lastEventType: null,
        lastError: null,
        contiguousByteLength: 0,
        integrityError: null,
        exactRecordCommitted: false,
      }
    }

    const input = timelineReadStream(timelinePath)
    let buffered = Buffer.alloc(0)
    let fileOffset = 0
    let lineNumber = 0
    let stopped = false
    let maxSequence = 0
    let terminalSeen = false
    let terminalSequence = null
    let terminalStartByte = null
    let lastEventType = null
    let lastError = null
    let contiguousByteLength = 0
    let integrityError = null
    let exactRecordCommitted = false

    const markIntegrityError = (detail) => {
      if (!integrityError) {
        integrityError = `Timeline integrity check failed for job ${jobId} at line ${lineNumber}: ${detail}`
      }
    }

    const processLine = async (fullLine) => {
      lineNumber += 1
      const recordStartByte = fileOffset
      fileOffset += fullLine.length
      let content = fullLine.subarray(0, fullLine.length - 1)
      if (content.at(-1) === 0x0d) content = content.subarray(0, content.length - 1)
      const rawLine = content.toString('utf8')
      if (!rawLine.trim()) {
        markIntegrityError('empty JSONL record')
        return
      }

      let payload
      try {
        payload = JSON.parse(rawLine)
      } catch {
        markIntegrityError('malformed JSONL record')
        return
      }

      const sequence = Number(payload?.sequence ?? 0)
      if (integrityError) return
      if (!Number.isInteger(sequence) || sequence <= 0) {
        markIntegrityError('invalid event sequence')
        return
      }
      if (payload?.jobId !== jobId) {
        markIntegrityError('event job identity does not match its timeline')
        return
      }
      if (terminalSeen) {
        markIntegrityError(`event sequence ${sequence} appears after terminal sequence ${terminalSequence}`)
        return
      }
      const nextSequence = maxSequence + 1
      if (sequence !== nextSequence) {
        markIntegrityError(`expected sequence ${nextSequence}, received ${sequence}`)
        return
      }
      if (
        expectedSerialized !== null
        && sequence === expectedSequence
        && rawLine !== expectedSerialized
      ) {
        markIntegrityError(`sequence ${sequence} contains different event content`)
        return
      }

      maxSequence = sequence
      lastEventType = payload.type ?? null
      if (payload.type === 'error') {
        lastError = typeof payload.error === 'string' ? payload.error : 'Unknown error'
      }
      if (payload.type === 'done') {
        terminalSeen = true
        terminalSequence = sequence
        terminalStartByte = recordStartByte
      }
      if (
        expectedSerialized !== null
        && sequence === expectedSequence
        && rawLine === expectedSerialized
      ) {
        exactRecordCommitted = true
      }
      contiguousByteLength = fileOffset
      if (onRecord && await onRecord(payload) === false) stopped = true
    }

    try {
      for await (const chunk of input) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        buffered = buffered.length === 0
          ? bytes
          : Buffer.concat([buffered, bytes])
        let newlineIndex = buffered.indexOf(0x0a)
        while (newlineIndex !== -1) {
          const fullLine = buffered.subarray(0, newlineIndex + 1)
          buffered = buffered.subarray(newlineIndex + 1)
          await processLine(fullLine)
          if (stopped) break
          newlineIndex = buffered.indexOf(0x0a)
        }
        if (stopped) break
      }
      if (!stopped && buffered.length > 0) {
        lineNumber += 1
        markIntegrityError('incomplete JSONL record without a trailing newline')
      }
    } finally {
      input.destroy()
    }
    return {
      maxSequence,
      terminalSeen,
      terminalSequence,
      terminalStartByte,
      lastEventType,
      lastError,
      contiguousByteLength,
      integrityError,
      exactRecordCommitted,
    }
  }

  async function inspectTimeline(jobId, options) {
    return await scanTimeline(jobId, options)
  }

  async function appendReconciliationEvent(jobId, event) {
    const line = `${JSON.stringify(event)}\n`
    let lastError = null
    for (let attempt = 1; attempt <= TIMELINE_APPEND_ATTEMPTS; attempt += 1) {
      try {
        await timelineAppend(jobTimelinePath(jobId), line)
        return
      } catch (error) {
        lastError = error
        try {
          const inspected = await inspectTimeline(jobId, {
            expectedSerialized: line.slice(0, -1),
            expectedSequence: Number(event.sequence ?? 0),
          })
          if (!inspected.integrityError && inspected.exactRecordCommitted) return
          if (
            inspected.integrityError
            || inspected.maxSequence >= Number(event.sequence ?? 0)
          ) {
            await fs.truncate(jobTimelinePath(jobId), inspected.contiguousByteLength)
            lastError = new Error(
              inspected.integrityError
                ?? `timeline sequence ${event.sequence} contains different event content`,
            )
          }
        } catch {}
        if (attempt < TIMELINE_APPEND_ATTEMPTS) await waitBeforeTimelineRetry(attempt)
      }
    }
    throw new TimelinePersistenceError(jobId, lastError ?? new Error('timeline append failed'))
  }

  async function reconcileInterruptedJob(jobId) {
    const existing = reconciliationLocks.get(jobId)
    if (existing) return await existing

    const reconciliation = (async () => {
      const metadata = await readJobMetadata(jobId)
      if (!metadata || liveJobs.has(jobId)) return metadata
      const active = metadata.status === 'running' || metadata.status === 'queued'
      const persistenceFailed = metadata.timelinePersistenceFailed === true
      const terminalMetadata = metadata.status === 'completed' || metadata.status === 'failed'
      let inspected = await inspectTimeline(jobId)
      const metadataLastSequence = Math.max(0, Number(metadata.lastSequence) || 0)
      const terminalConsistent = (
        !inspected.integrityError
        && inspected.terminalSeen
        && inspected.lastEventType === 'done'
        && inspected.maxSequence === metadataLastSequence
        && (
          (metadata.status === 'completed' && !inspected.lastError)
          || (metadata.status === 'failed' && Boolean(inspected.lastError))
        )
      )
      if (!active && !persistenceFailed && (!terminalMetadata || terminalConsistent)) {
        return metadata
      }

      let integrityDetail = inspected.integrityError
      if (inspected.integrityError) {
        await fs.truncate(jobTimelinePath(jobId), inspected.contiguousByteLength)
        inspected = await inspectTimeline(jobId)
      }

      // A durable failure terminal is safe to adopt after a metadata-write
      // failure. A success terminal paired with still-active metadata is not:
      // remove that uncommitted terminal before appending failure semantics so
      // replay can never stop on the stale success `done`.
      if (inspected.terminalSeen && !inspected.lastError) {
        integrityDetail ??= (
          `Timeline integrity check failed for job ${jobId}: `
          + 'terminal event was not committed by terminal metadata'
        )
        await fs.truncate(jobTimelinePath(jobId), inspected.terminalStartByte)
        inspected = await inspectTimeline(jobId)
      }

      const now = new Date().toISOString()
      const recoveryError = persistenceFailed
        ? String(metadata.error ?? 'Timeline persistence failed')
        : integrityDetail
          ? integrityDetail
          : terminalMetadata
            ? `Timeline integrity check failed for job ${jobId}: terminal metadata does not match the durable timeline`
            : INTERRUPTED_JOB_ERROR

      if (!inspected.terminalSeen) {
        if (inspected.lastEventType !== 'error') {
          const errorEvent = {
            jobId,
            sequence: inspected.maxSequence + 1,
            timestamp: Date.now(),
            type: 'error',
            error: recoveryError,
          }
          await appendReconciliationEvent(jobId, errorEvent)
          inspected = await inspectTimeline(jobId)
        }
        const doneEvent = {
          jobId,
          sequence: inspected.maxSequence + 1,
          timestamp: Date.now(),
          type: 'done',
        }
        await appendReconciliationEvent(jobId, doneEvent)
        inspected = await inspectTimeline(jobId)
      }

      const reconciledMetadata = {
        ...metadata,
        status: 'failed',
        error: inspected.lastError ?? recoveryError,
        updatedAt: now,
        completedAt: metadata.completedAt
          ?? metadata.updatedAt
          ?? metadata.requestedAt
          ?? now,
        lastSequence: inspected.maxSequence,
        timelinePersistenceFailed: false,
      }
      // Strict ordering: both timeline terminal records are durable before the
      // metadata status and high-water mark advance.
      await writeJobMetadata(reconciledMetadata)
      return reconciledMetadata
    })()
    reconciliationLocks.set(jobId, reconciliation)
    try {
      return await reconciliation
    } finally {
      if (reconciliationLocks.get(jobId) === reconciliation) {
        reconciliationLocks.delete(jobId)
      }
    }
  }

  async function replayTimeline(record, jobId, sinceSequence, throughSequence = Number.POSITIVE_INFINITY) {
    return await scanTimeline(jobId, {
      onRecord: async payload => {
        const sequence = Number(payload.sequence)
        if (sequence <= sinceSequence || sequence > throughSequence) return true
        return await subscriberRegistry.sendReplay(record, payload)
      },
    })
  }

  async function streamJob(jobId, sinceSequence, res) {
    let persistedMetadata = await readJobMetadata(jobId)
    const live = liveJobs.get(jobId)
    const persistenceFailure = timelinePersistence.get(jobId)?.failureMetadata
    if (!live && !persistenceFailure && persistedMetadata) {
      persistedMetadata = await reconcileInterruptedJob(jobId)
    }
    const metadata = live?.metadata ?? persistenceFailure ?? persistedMetadata
    if (!metadata) return false

    const normalizedSince = Math.max(0, Number(sinceSequence) || 0)
    const statusActive = metadata.status === 'running' || metadata.status === 'queued'
    const liveAtRegistration = statusActive && Boolean(live)
    const replayThrough = liveAtRegistration
      ? Math.max(normalizedSince, Number(metadata.lastSequence ?? 0))
      : Number.POSITIVE_INFINITY
    const pendingAtRegistration = snapshotPendingTimelineEvents(
      jobId,
      normalizedSince,
      replayThrough,
    )

    // Register synchronously before the first replay await. Live events emitted
    // while disk history is streaming are buffered on this subscriber, then
    // reconciled by sequence after the replay high-water mark.
    const subscriber = subscriberRegistry.register(jobId, res, {
      sinceSequence: normalizedSince,
      replaying: true,
    })
    subscriberRegistry.sendComment(subscriber, ': connected\n\n')

    const replayed = await replayTimeline(
      subscriber,
      jobId,
      normalizedSince,
      replayThrough,
    )
    if (replayed.integrityError) {
      subscriberRegistry.close(subscriber)
      return false
    }
    for (const payload of pendingAtRegistration.events) {
      if (!await subscriberRegistry.sendReplay(subscriber, payload)) break
    }

    if (liveAtRegistration) {
      return subscriberRegistry.finishReplay(subscriber)
    }

    // A terminal replay can itself hit socket backpressure. In that case
    // writeEntry has already called end() and retained a bounded destroy
    // deadline. Do not clear that deadline/listeners here.
    if (!subscriber.blocked && !subscriber.terminalEnding) {
      subscriberRegistry.close(subscriber, { end: false })
    }
    return false
  }

  async function streamCard(cardId, jobId, sinceSequence, res) {
    if (!cardId || closing) return false
    const normalizedSince = Math.max(0, Number(sinceSequence) || 0)
    // Subscribe before ANY metadata/replay await: even a new job starting during
    // lookup must reach this connection. Registry buffers are bounded as usual.
    const subscriber = cardSubscriberRegistry.register(cardId, res, {
      persistent: true,
      replayJobId: jobId || null,
      sinceSequence: normalizedSince,
      replaying: Boolean(jobId),
    })
    cardSubscriberRegistry.sendComment(subscriber, ': connected\n\n')
    if (!jobId) return !subscriber.closed
    try {
      let metadata = liveJobs.get(jobId)?.metadata
        ?? timelinePersistence.get(jobId)?.failureMetadata
        ?? await readJobMetadata(jobId)
      // Never disclose a different card's history. Invalid replay cursors close
      // the stream (headers have already been flushed by the HTTP route).
      if (!metadata || metadata.cardId !== cardId) {
        cardSubscriberRegistry.close(subscriber)
        return false
      }
      if (!liveJobs.has(jobId) && !timelinePersistence.get(jobId)?.failureMetadata) {
        metadata = await reconcileInterruptedJob(jobId)
      }
      const through = Math.max(normalizedSince, Number(metadata.lastSequence) || 0)
      const pending = snapshotPendingTimelineEvents(jobId, normalizedSince, through)
      const replayed = await scanTimeline(jobId, {
        onRecord: async payload => {
          if (payload.sequence <= normalizedSince || payload.sequence > through) return true
          return await cardSubscriberRegistry.sendReplay(subscriber, payload)
        },
      })
      if (replayed.integrityError) {
        cardSubscriberRegistry.close(subscriber)
        return false
      }
      for (const payload of pending.events) {
        if (!await cardSubscriberRegistry.sendReplay(subscriber, payload)) break
      }
      return cardSubscriberRegistry.finishReplay(subscriber)
    } catch (error) {
      cardSubscriberRegistry.close(subscriber)
      throw error
    }
  }

  // daemon-05 (core): prune terminal job metadata + timeline jsonl past a TTL
  // so ~/.codesurf/jobs and /timelines do not grow without bound. Keeps the
  // newest `keepRecent` terminal jobs regardless of age, then deletes terminal
  // jobs older than `maxAgeMs`. Never touches live jobs; stale active-status
  // records from a prior process are reconciled first. Checkpoint-record
  // retention is deliberately out of scope here — it crosses into
  // checkpoints.mjs + per-workspace dirs.
  async function sweepJobRetention({ maxAgeMs = 30 * 24 * 60 * 60 * 1000, keepRecent = 200 } = {}) {
    let entries
    try {
      entries = await fs.readdir(jobsDir)
    } catch {
      return { pruned: 0 }
    }
    const now = Date.now()
    const terminal = []
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      if (liveJobs.has(id)) continue
      let meta
      try {
        meta = JSON.parse(await fs.readFile(join(jobsDir, name), 'utf8'))
      } catch {
        continue
      }
      const activeStatus = meta?.status === 'running' || meta?.status === 'queued'
      const wasTerminalStatus = meta?.status === 'completed' || meta?.status === 'failed'
      const metadataLastSequence = Number(meta?.lastSequence)
      const metadataLooksInconsistent = wasTerminalStatus && (
        !Number.isInteger(metadataLastSequence)
        || metadataLastSequence <= 0
      )
      if (
        activeStatus
        || meta?.timelinePersistenceFailed === true
        || metadataLooksInconsistent
      ) {
        try {
          // The daemon invokes this sweep once on startup. Any active-status
          // record without a matching live job belongs to the prior process and
          // must be reconciled here, rather than remaining permanently exempt
          // until somebody happens to reopen its SSE endpoint.
          meta = await reconcileInterruptedJob(id) ?? meta
        } catch {
          // If storage remains unavailable, the record is still not truly live.
          // Include old interrupted artifacts in retention using their last
          // durable activity time so repeated finalization failures stay bounded.
        }
      }
      const terminalStatus = meta?.status === 'completed' || meta?.status === 'failed'
      const interruptedStatus = meta?.status === 'running' || meta?.status === 'queued'
      if (!terminalStatus && !interruptedStatus && meta?.timelinePersistenceFailed !== true) continue
      terminal.push({
        id,
        completedAt: Date.parse(
          meta?.completedAt
          ?? meta?.updatedAt
          ?? meta?.requestedAt
          ?? '',
        ) || 0,
      })
    }
    terminal.sort((a, b) => b.completedAt - a.completedAt)
    let pruned = 0
    for (const { id, completedAt } of terminal.slice(keepRecent)) {
      if (completedAt && now - completedAt < maxAgeMs) continue
      try {
        await fs.rm(jobMetaPath(id), { force: true })
        await fs.rm(jobTimelinePath(id), { force: true })
        timelinePersistence.delete(id)
        timelineWriteTails.delete(id)
        pruned += 1
      } catch { /* best effort */ }
    }
    return { pruned }
  }

  // Cancel every in-flight job and stop the heartbeat. Called from the daemon's
  // shutdown() so SIGTERM/SIGINT/uncaught errors do not orphan Claude SDK
  // queries or spawned codex/opencode/hermes CLI children (which run with
  // file-write access and would otherwise keep running, reparented to init).
  async function shutdown() {
    // D3: close first, irreversibly. Every start from here on is rejected and
    // pumpJobQueue is inert, so nothing can be launched behind this sweep.
    closing = true
    const jobs = Array.from(liveJobs.values())
    const cancellationResults = await Promise.all(jobs.map(async live => {
      try {
        return await cancelJob(live.id)
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }))
    const runPromises = jobs
      .map(live => live.runPromise)
      .filter(Boolean)
    let runnersSettled = true
    if (runPromises.length > 0) {
      runnersSettled = await Promise.race([
        Promise.allSettled(runPromises).then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), 3_000)),
      ])
    }
    subscriberRegistry.shutdown()
    cardSubscriberRegistry.shutdown()
    for (const timer of metadataFlushTimers.values()) clearTimeout(timer)
    metadataFlushTimers.clear()
    if (failedCleanupTasks.size > 0) {
      await Promise.allSettled(Array.from(failedCleanupTasks))
    }
    const failures = cancellationResults
      .filter(result => !result?.ok)
      .map(result => result?.error || 'job cancellation was not confirmed')
    if (!runnersSettled) failures.push('one or more job runners did not settle after cancellation')
    if (failures.length > 0) {
      throw new Error(`Daemon chat shutdown incomplete: ${failures.join('; ')}`)
    }
  }

  return {
    startJob,
    cancelJob,
    answerToolPermission,
    getJobState,
    getPersistenceState,
    streamJob,
    streamCard,
    shutdown,
    sweepJobRetention,
    listLiveJobIds() {
      return Array.from(liveJobs.keys())
    },
  }
}

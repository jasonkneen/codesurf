/**
 * Codex provider — runs `codex exec --json` subprocess.
 */

import { spawn, execFile } from 'child_process'
import { promises as fs, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, relative, resolve, sep } from 'path'
import { promisify } from 'util'
import { getAgentPath, getShellEnvPath } from '../../agent-paths'
import { buildSafeSpawnEnv } from '../../ipc/terminal-helpers'
import { writeMCPConfigToWorkspace, writeTileMcpConfig, getTileToken } from '../../mcp-server'
import {
  BoundedLineDecoder,
  BoundedTextAccumulator,
  MAX_PROVIDER_ACCUMULATED_OUTPUT_BYTES,
  MAX_PROVIDER_DIAGNOSTIC_BYTES,
  boundProviderHistoryText,
  boundRecentText,
} from '../bounded-output'
import { sanitizeToolOutputText } from '../output-sanitizers'
import { createRuntimeCheckpoint } from '../runtime-checkpoints'
import {
  completeStableContextCliTurn,
  invalidateStableContextSelection,
  selectStableContextForTurn,
} from '../stable-session-context'
import { buildCodexSpawnArgs } from './agent-mode-payloads'
import type { ChatRequest, RuntimeChatSessionState } from '../types'
import {
  cleanupMaterializedCodexImages,
  insertCodexImageArgs,
  materializeVerifiedCodexImages,
} from '../provider-image-attachments.ts'
import {
  awaitGuardedPreparation,
  codexPrelaunchBoundary,
  providerLaunchIsCurrent,
  type ProviderLaunchGuard,
} from '../provider-launch-guard.ts'
export {
  cleanupMaterializedCodexImages,
  insertCodexImageArgs,
  materializeVerifiedCodexImages,
} from '../provider-image-attachments.ts'
import {
  sendStream,
  cloneChatMessages,
  getPreparedMessages,
  upsertRuntimeSessionState,
  chatRequestScope,
  chatStreamScopeKey,
  getCardSessionId,
  isCurrentChatProcess,
  setCardSessionId,
  markRoomPromptAccepted,
  processTreeSpawnOptions,
  registerActiveChatProcess,
  stopActiveChatProcess,
  terminateProcessTree,
} from '../runtime'

const execFileAsync = promisify(execFile)

export interface StreamToolFileChange {
  path: string
  previousPath?: string
  changeType: 'add' | 'update' | 'delete' | 'move'
  additions: number
  deletions: number
  diff: string
}

interface StreamToolCommandEntry {
  label: string
  command?: string
  output?: string
  kind?: 'search' | 'read' | 'command'
}

interface CodexFileSnapshot {
  displayPath: string
  changeType: StreamToolFileChange['changeType']
  existed: boolean
  content: string | null
}

function normalizeCodexShellCommand(command: string): string {
  const trimmed = command.trim()
  const quotedMatch = trimmed.match(/^\/bin\/zsh -lc '([\s\S]*)'$/)
  if (quotedMatch) return quotedMatch[1].replace(/'\\''/g, "'")
  const plainMatch = trimmed.match(/^\/bin\/zsh -lc (.+)$/)
  if (plainMatch) return plainMatch[1].trim()
  return trimmed
}

function classifyCodexCommand(command: string): StreamToolCommandEntry['kind'] {
  const normalized = command.trim()
  if (/(^|\s)(rg|grep|fd|findstr)\b/.test(normalized)) return 'search'
  if (/(^|\s)(cat|sed|head|tail|less|more|bat|ls)\b/.test(normalized)) return 'read'
  return 'command'
}

function buildExploreToolName(entries: StreamToolCommandEntry[]): string {
  const readCount = entries.filter(entry => entry.kind === 'read').length
  const searchCount = entries.filter(entry => entry.kind === 'search').length
  const labelParts: string[] = []
  if (readCount > 0) labelParts.push(`${readCount} file${readCount === 1 ? '' : 's'}`)
  if (searchCount > 0) labelParts.push(`${searchCount} search${searchCount === 1 ? '' : 'es'}`)
  return labelParts.length > 0 ? `Explored ${labelParts.join(', ')}` : 'Explored workspace'
}

function buildEditedToolName(fileChanges: StreamToolFileChange[]): string {
  return `Edited ${fileChanges.length} file${fileChanges.length === 1 ? '' : 's'}`
}

function countDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions += 1
    if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions }
}

function changeTypeFromCodexKind(kind: unknown): StreamToolFileChange['changeType'] {
  if (kind === 'add' || kind === 'delete' || kind === 'move') return kind
  return 'update'
}

function mergeFileChanges(fileChanges: StreamToolFileChange[]): StreamToolFileChange[] {
  const merged = new Map<string, StreamToolFileChange>()

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

async function readSnapshotContent(filePath: string): Promise<{ existed: boolean; content: string | null }> {
  try {
    const buffer = await fs.readFile(filePath)
    if (buffer.includes(0)) return { existed: true, content: null }
    return { existed: true, content: buffer.toString('utf8') }
  } catch {
    return { existed: false, content: null }
  }
}

// Synchronous variant used to capture a Codex pre-edit snapshot without
// yielding the event loop. The async version races against Codex's write:
// by the time `await fs.readFile` resolves, Codex has often already flushed
// bytes to disk, so `before.content` equals `after.content` and the
// resulting diff is empty (+0/-0). The fs.readFileSync call blocks the
// main process for a few ms, which is acceptable for source-file sizes.
function readSnapshotContentSync(filePath: string): { existed: boolean; content: string | null } {
  try {
    const buffer = readFileSync(filePath)
    if (buffer.includes(0)) return { existed: true, content: null }
    return { existed: true, content: buffer.toString('utf8') }
  } catch {
    return { existed: false, content: null }
  }
}

export function getDisplayPath(filePath: string, workspaceDir?: string): string {
  const resolvedPath = resolve(filePath)
  const resolvedWorkspace = workspaceDir ? resolve(workspaceDir) : ''
  if (resolvedWorkspace && (resolvedPath === resolvedWorkspace || resolvedPath.startsWith(`${resolvedWorkspace}${sep}`))) {
    const rel = relative(resolvedWorkspace, resolvedPath)
    return rel || resolvedPath.split(sep).pop() || resolvedPath
  }
  return resolvedPath
}

export function resolveCodexFilePath(filePath: string, workspaceDir?: string): string {
  if (workspaceDir && !filePath.startsWith('/')) return resolve(workspaceDir, filePath)
  return resolve(filePath)
}

function normalizeNoIndexDiffPaths(diff: string, beforePath: string | null, afterPath: string | null, displayPath: string): string {
  let normalized = diff
  if (beforePath) normalized = normalized.split(beforePath).join(`a/${displayPath}`)
  if (afterPath) normalized = normalized.split(afterPath).join(`b/${displayPath}`)
  return normalized.trim()
}

async function buildSnapshotDiff(before: CodexFileSnapshot, currentPath: string): Promise<Pick<StreamToolFileChange, 'diff' | 'additions' | 'deletions'>> {
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
      // execFile rejects with an Error augmented with code/stdout/stderr.
      const execErr = error as { code?: number; stdout?: string; stderr?: string }
      if (execErr?.code === 1) {
        diff = execErr.stdout || execErr.stderr || ''
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

async function summarizeCodexFileChanges(
  changes: Array<{ path?: unknown; kind?: unknown }>,
  snapshots: Map<string, CodexFileSnapshot>,
  workspaceDir?: string,
): Promise<StreamToolFileChange[]> {
  const fileChanges: StreamToolFileChange[] = []

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

// createRuntimeCheckpoint is shared (../runtime-checkpoints). getDisplayPath stays for Codex diffs.

export async function chatCodex(
  req: ChatRequest,
  launchGuard?: ProviderLaunchGuard,
): Promise<void> {
  const scope = chatRequestScope(req)
  const scopeKey = chatStreamScopeKey(scope)
  const lastUserMsg = [...getPreparedMessages(req)].reverse().find(m => m.role === 'user')
  if (!lastUserMsg) {
    sendStream(scope, { type: 'error', error: 'No user message' })
    return
  }

  const codexBin = getAgentPath('codex') || 'codex'
  const shellPath = getShellEnvPath()
  const runtimeMessages = cloneChatMessages(req.messages)
  const resumeThreadId = req.sessionId ?? getCardSessionId(scope, req.provider) ?? null
  const stableContext = selectStableContextForTurn({
    scope,
    provider: req.provider,
    sessionId: resumeThreadId,
    contextPrompt: req.contextPrompt,
  })
  const runtimeSession: RuntimeChatSessionState = {
    provider: req.provider,
    model: req.model,
    sessionId: resumeThreadId,
    jobId: req.jobId ?? null,
    jobSequence: typeof req.jobSequence === 'number' ? req.jobSequence : 0,
    executionTarget: req.executionTarget === 'cloud' ? 'cloud' : 'local',
    cloudHostId: req.cloudHostId ?? null,
    isStreaming: true,
    messages: runtimeMessages,
  }
  void upsertRuntimeSessionState(req, runtimeSession)

  // Build the `codex exec` argv from the shared, pure builder. It maps
  // AgentMode.tools onto the sandbox (Codex's only per-toolset lever), injects
  // the persona into the prompt, and FAILS CLOSED (throws) for both an
  // unenforceable deny-all tool list (A-PR1 #1b, CODEX_DENY_ALL_ERROR) and a
  // selected agent whose definition has not resolved (A-PR1 BLOCKING-1). When a
  // thread ID is present it emits `exec resume <threadId>` to preserve multi-turn
  // context; `--ignore-user-config` keeps the run isolated from ~/.codex.
  let args: string[]
  let materializedImages: { directory: string | null; paths: string[] } = { directory: null, paths: [] }
  const launchIsCurrent = (): boolean => providerLaunchIsCurrent(launchGuard)
  const abandonPrelaunch = async (): Promise<void> => {
    invalidateStableContextSelection(stableContext)
    if (materializedImages.directory) {
      const directory = materializedImages.directory
      materializedImages = { directory: null, paths: [] }
      await cleanupMaterializedCodexImages(directory).catch(() => {})
    }
  }
  try {
    args = buildCodexSpawnArgs({
      agentId: req.agentId,
      agentMode: req.agentMode,
      mode: req.mode,
      model: req.model,
      userContent: lastUserMsg.content,
      resumeThreadId,
      workspaceDir: req.workspaceDir,
      contextPrompt: stableContext.contextPrompt,
    })
    const preparedImages = await awaitGuardedPreparation(
      launchGuard,
      materializeVerifiedCodexImages(req.imageAttachments),
      prepared => prepared.directory
        ? cleanupMaterializedCodexImages(prepared.directory)
        : undefined,
    )
    if (!preparedImages.ok) {
      invalidateStableContextSelection(stableContext)
      return
    }
    materializedImages = preparedImages.value
    args = insertCodexImageArgs(args, materializedImages.paths)
  } catch (err) {
    if (!launchIsCurrent()) {
      await abandonPrelaunch()
      return
    }
    invalidateStableContextSelection(stableContext)
    // Clear isStreaming before returning — we already upserted true above.
    // Leaving it stuck true makes resume/job UI treat the turn as live forever.
    runtimeSession.isStreaming = false
    void upsertRuntimeSessionState(req, runtimeSession)
    sendStream(scope, { type: 'error', error: err instanceof Error ? err.message : String(err) })
    sendStream(scope, { type: 'done' })
    return
  }

  const cleanupMaterializedImages = (): void => {
    if (!materializedImages.directory) return
    const directory = materializedImages.directory
    materializedImages = { directory: null, paths: [] }
    void cleanupMaterializedCodexImages(directory)
  }

  if (req.workspaceDir) {
    await writeMCPConfigToWorkspace(req.workspaceDir).catch(() => {})
    if (!launchIsCurrent()) {
      await abandonPrelaunch()
      return
    }
  }

  const spawnEnv: Record<string, string> = buildSafeSpawnEnv({ ...(shellPath && { PATH: shellPath }) })
  // Supply only a tile-scoped MCP config. Failure leaves MCP unavailable
  // instead of falling back to the global bearer.
  let mcpConfigPath: string | null = null
  if (req.workspaceId) {
    try {
      // Do not launch Codex until the scoped config is atomically in place:
      // the CLI reads CODESURF_MCP_CONFIG during startup.
      mcpConfigPath = await writeTileMcpConfig(req.workspaceId, req.cardId)
      spawnEnv.CODESURF_MCP_TILE_TOKEN = getTileToken(req.workspaceId, req.cardId)
      spawnEnv.CODESURF_WORKSPACE_ID = req.workspaceId
    } catch {
      // invalid workspace/card path — fail closed without MCP
    }
    if (!launchIsCurrent()) {
      await abandonPrelaunch()
      return
    }
  }
  if (mcpConfigPath) spawnEnv.CODESURF_MCP_CONFIG = mcpConfigPath

  const launched = await codexPrelaunchBoundary.run({
    guard: launchGuard,
    prepare: () => ({
      command: codexBin,
      args,
      options: processTreeSpawnOptions({
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv,
      }),
    }),
    disposePrepared: () => abandonPrelaunch(),
    launch: prepared => spawn(prepared.command, prepared.args, prepared.options),
  })
  if (!launched.ok) {
    await abandonPrelaunch()
    return
  }
  const proc = launched.value

  if (!launchIsCurrent()) {
    const termination = await terminateProcessTree(proc)
    if (!termination.confirmed) {
      throw new Error(`Superseded Codex process could not be terminated: ${termination.detail}`)
    }
    await abandonPrelaunch()
    return
  }

  if (!registerActiveChatProcess(scopeKey, proc)) {
    const termination = await terminateProcessTree(proc)
    if (!termination.confirmed) {
      throw new Error(`Duplicate Codex process could not be terminated: ${termination.detail}`)
    }
    throw new Error('Codex launch refused because the previous chat process is still active')
  }
  const pendingSnapshots = new Map<string, CodexFileSnapshot>()
  const aggregatedFileChanges = new Map<string, StreamToolFileChange>()
  const exploreEntries: StreamToolCommandEntry[] = []
  const assistantText = new BoundedTextAccumulator(MAX_PROVIDER_ACCUMULATED_OUTPUT_BYTES)
  let editsStarted = false
  let exploreStarted = false
  let commandSeq = 0
  const stdoutDecoder = new BoundedLineDecoder()
  let stdoutChain = Promise.resolve()
  // Set to true after a fatal event (checkpoint failure, turn.failed, error)
  // so buffered stdout chunks are not streamed after the error chip.
  let aborted = false
  let sawProviderAcceptance = false
  const noteProviderAcceptance = (): void => {
    sawProviderAcceptance = true
    markRoomPromptAccepted(scope)
  }

  const handleCodexJsonEvent = async (evt: any): Promise<void> => {
    if (!evt || typeof evt !== 'object') return
    if (aborted || !launchIsCurrent()) return

    // Surface turn.failed / top-level error events as explicit error chips
    if (evt.type === 'turn.failed' || evt.type === 'error') {
      const msg = evt.error?.message ?? evt.message ?? `Codex event: ${evt.type}`
      aborted = true
      sendStream(scope, { type: 'error', error: String(msg) })
      return
    }

    if (evt.type === 'thread.started' && typeof evt.thread_id === 'string') {
      setCardSessionId(scope, req.provider, evt.thread_id)
      runtimeSession.sessionId = evt.thread_id
      void upsertRuntimeSessionState(req, runtimeSession)
      sendStream(scope, { type: 'session', sessionId: evt.thread_id })
      return
    }
    if (evt.type === 'turn.completed') {
      noteProviderAcceptance()
      return
    }

    if (evt.type === 'item.started') {
      const item = evt.item
      if (item?.type === 'file_change' && Array.isArray(item.changes)) {
        noteProviderAcceptance()
        // Snapshot pre-edit content SYNCHRONOUSLY before awaiting anything.
        // Codex writes the files very shortly after emitting `item.started`;
        // any `await` here yields the event loop long enough for the write
        // to land, which makes before == after and produces empty (+0/-0)
        // diffs in the chat tile. Must happen before createRuntimeCheckpoint.
        const checkpointPaths: string[] = []
        for (const change of item.changes) {
          if (typeof change?.path !== 'string') continue
          const resolvedPath = resolveCodexFilePath(change.path, req.workspaceDir)
          checkpointPaths.push(resolvedPath)
          const snapshot = readSnapshotContentSync(resolvedPath)
          pendingSnapshots.set(resolvedPath, {
            displayPath: getDisplayPath(resolvedPath, req.workspaceDir),
            changeType: changeTypeFromCodexKind(change.kind),
            existed: snapshot.existed,
            content: snapshot.content,
          })
        }
        const checkpoint = await createRuntimeCheckpoint(req, 'CodexFileChange', checkpointPaths, {
          changeKinds: item.changes.map((change: { kind?: unknown }) => String(change?.kind ?? 'update')),
        })
        if (!checkpoint.ok) {
          aborted = true
          sendStream(scope, { type: 'error', error: `Checkpoint creation failed before Codex file changes: ${checkpoint.error ?? 'unknown error'}` })
          const termination = await stopActiveChatProcess(scopeKey)
          invalidateStableContextSelection(stableContext)
          runtimeSession.isStreaming = false
          void upsertRuntimeSessionState(req, runtimeSession)
          if (!termination?.confirmed) {
            sendStream(scope, {
              type: 'error',
              error: `Codex process-tree termination failed: ${termination?.detail ?? 'process ownership was lost'}`,
            })
          } else {
            sendStream(scope, {
              type: 'done',
              sessionId: runtimeSession.sessionId ?? undefined,
            })
          }
          return
        }
      }
      return
    }

    if (evt.type !== 'item.completed') return
    const item = evt.item
    if (!item || typeof item !== 'object') return

    if (item.type === 'agent_message' && typeof item.text === 'string' && item.text) {
      noteProviderAcceptance()
      assistantText.append(item.text)
      sendStream(scope, { type: 'text', text: item.text })
      return
    }

    if (item.type === 'command_execution' && typeof item.command === 'string') {
      noteProviderAcceptance()
      const command = normalizeCodexShellCommand(item.command)
      const kind = classifyCodexCommand(command)
      const output = boundRecentText(
        sanitizeToolOutputText(typeof item.aggregated_output === 'string' ? item.aggregated_output : ''),
        MAX_PROVIDER_DIAGNOSTIC_BYTES,
        MAX_PROVIDER_DIAGNOSTIC_BYTES / 4,
      )
      if (kind === 'search' || kind === 'read') {
        if (!exploreStarted) {
          sendStream(scope, { type: 'tool_start', toolId: 'codex-explore', toolName: 'Exploring workspace' })
          exploreStarted = true
        }
        if (exploreEntries.length >= 64) exploreEntries.shift()
        exploreEntries.push({ label: command, command, output, kind })
        sendStream(scope, {
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
        sendStream(scope, { type: 'tool_start', toolId, toolName: 'exec_command' })
        sendStream(scope, {
          type: 'tool_summary',
          toolId,
          toolName: 'exec_command',
          commandEntries: [{ label: command, command, output, kind: 'command' }],
        })
      }
      return
    }

    if (item.type === 'file_change' && Array.isArray(item.changes)) {
      noteProviderAcceptance()
      const fileChanges = await summarizeCodexFileChanges(item.changes, pendingSnapshots, req.workspaceDir)
      if (fileChanges.length === 0) return
      for (const change of fileChanges) {
        const key = `${change.path}::${change.previousPath ?? ''}::${change.changeType}`
        aggregatedFileChanges.set(key, change)
      }
      const mergedFileChanges = Array.from(aggregatedFileChanges.values())
      if (!editsStarted) {
        sendStream(scope, { type: 'tool_start', toolId: 'codex-file-changes', toolName: buildEditedToolName(mergedFileChanges) })
        editsStarted = true
      }
      sendStream(scope, {
        type: 'tool_summary',
        toolId: 'codex-file-changes',
        toolName: buildEditedToolName(mergedFileChanges),
        fileChanges: mergedFileChanges,
        fileChangesTrusted: req.executionTarget !== 'cloud' && Boolean(req.workspaceId),
        fileChangesOrigin: req.executionTarget !== 'cloud' && req.workspaceId
          ? {
            workspaceId: req.workspaceId,
            cardId: req.cardId,
            provider: req.provider,
            executionTarget: 'local',
            sessionId: runtimeSession.sessionId ?? null,
          }
          : undefined,
      })
    }
  }

  const BACKPRESSURE_THRESHOLD = 1024 * 1024 // 1 MB of buffered unprocessed stdout
  let queuedBytes = 0
  proc.stdout?.on('data', (chunk: Buffer) => {
    const lines = stdoutDecoder.push(chunk.toString())

    // Backpressure: pause stdout when the async processing chain falls behind.
    const batchBytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0)
    queuedBytes += batchBytes
    if (queuedBytes > BACKPRESSURE_THRESHOLD) {
      proc.stdout?.pause()
    }

    stdoutChain = stdoutChain.then(async () => {
      for (const line of lines) {
        if (aborted) break
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const evt = JSON.parse(trimmed)
          await handleCodexJsonEvent(evt)
        } catch {
          if (!aborted && launchIsCurrent()) {
            noteProviderAcceptance()
            sendStream(scope, { type: 'text', text: `${line}\n` })
          }
        }
      }
    }).catch(() => {}).finally(() => {
      queuedBytes -= batchBytes
      // Resume reading once the chain has drained below the threshold.
      if (queuedBytes <= BACKPRESSURE_THRESHOLD) {
        proc.stdout?.resume()
      }
    })
  })

  const stderrBuf = new BoundedTextAccumulator(MAX_PROVIDER_DIAGNOSTIC_BYTES)
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf.append(chunk.toString())
  })

  // H-9: identity-guard — only clean up and emit done/error if this proc is
  // still the active one. A rapid re-send replaces activeProcesses[cardId]
  // before the old proc's close handler fires; without this guard the old
  // handler would delete the new proc's entry and inject stale done/error
  // events into the new turn.
  const isCurrent = (): boolean => isCurrentChatProcess(scopeKey, proc)

  proc.on('close', (code) => {
    cleanupMaterializedImages()
    if (!isCurrent()) return // superseded — new turn owns the slot
    void (async () => {
      const termination = await stopActiveChatProcess(scopeKey)
      if (!termination?.confirmed) {
        invalidateStableContextSelection(stableContext)
        runtimeSession.isStreaming = false
        void upsertRuntimeSessionState(req, runtimeSession)
        sendStream(scope, {
          type: 'error',
          error: `Codex process-tree exit could not be confirmed: ${termination?.detail ?? 'process ownership was lost'}`,
        })
        return
      }
      if (aborted) {
        invalidateStableContextSelection(stableContext)
        runtimeSession.isStreaming = false
        void upsertRuntimeSessionState(req, runtimeSession)
        // Always emit done on abort so tool blocks leave `running` (reducer
        // finalizes tools only on `done`, not on `error` alone).
        sendStream(scope, { type: 'done', sessionId: runtimeSession.sessionId ?? undefined })
        return
      }
      if (code !== 0) invalidateStableContextSelection(stableContext)
      stdoutChain = stdoutChain.then(async () => {
        const pendingStdout = stdoutDecoder.flush()
        if (pendingStdout?.trim()) {
          try {
            await handleCodexJsonEvent(JSON.parse(pendingStdout.trim()))
          } catch {
            assistantText.append(pendingStdout)
            sendStream(scope, { type: 'text', text: pendingStdout })
          }
        }
        if (assistantText.value.trim()) {
          runtimeSession.messages = [
            ...runtimeMessages,
            { role: 'assistant', content: boundProviderHistoryText(assistantText.value) },
          ]
        }
        completeStableContextCliTurn(stableContext, {
          exitCode: code,
          sawProviderAcceptance,
          providerError: aborted,
          sessionId: getCardSessionId(scope, req.provider) ?? resumeThreadId,
        })
        if (code === 0 && !aborted && sawProviderAcceptance) markRoomPromptAccepted(scope)
        runtimeSession.sessionId = getCardSessionId(scope, req.provider) ?? runtimeSession.sessionId
        runtimeSession.isStreaming = false
        void upsertRuntimeSessionState(req, runtimeSession)
        if (code !== 0 && stderrBuf.value.trim()) {
          sendStream(scope, { type: 'error', error: stderrBuf.value.trim() })
        }
        sendStream(scope, { type: 'done', sessionId: runtimeSession.sessionId ?? undefined })
      }).catch(() => {
        invalidateStableContextSelection(stableContext)
        if (assistantText.value.trim()) {
          runtimeSession.messages = [
            ...runtimeMessages,
            { role: 'assistant', content: boundProviderHistoryText(assistantText.value) },
          ]
        }
        runtimeSession.sessionId = getCardSessionId(scope, req.provider) ?? runtimeSession.sessionId
        runtimeSession.isStreaming = false
        void upsertRuntimeSessionState(req, runtimeSession)
        if (code !== 0 && stderrBuf.value.trim()) {
          sendStream(scope, { type: 'error', error: stderrBuf.value.trim() })
        }
        sendStream(scope, { type: 'done', sessionId: runtimeSession.sessionId ?? undefined })
      })
    })().catch(error => {
      invalidateStableContextSelection(stableContext)
      runtimeSession.isStreaming = false
      void upsertRuntimeSessionState(req, runtimeSession)
      sendStream(scope, {
        type: 'error',
        error: `Codex process finalization failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    })
  })

  proc.on('error', (err) => {
    cleanupMaterializedImages()
    if (!isCurrent()) return // superseded — new turn owns the slot
    void (async () => {
      const termination = await stopActiveChatProcess(scopeKey)
      invalidateStableContextSelection(stableContext)
      runtimeSession.isStreaming = false
      void upsertRuntimeSessionState(req, runtimeSession)
      sendStream(scope, { type: 'error', error: err.message.includes('ENOENT')
        ? 'Codex CLI not found. Install: npm install -g @openai/codex'
        : err.message })
      if (!termination?.confirmed) {
        sendStream(scope, {
          type: 'error',
          error: `Codex process-tree exit could not be confirmed: ${termination?.detail ?? 'process ownership was lost'}`,
        })
        return
      }
      sendStream(scope, { type: 'done', sessionId: runtimeSession.sessionId ?? undefined })
    })().catch(error => {
      sendStream(scope, {
        type: 'error',
        error: `Codex process finalization failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    })
  })
}

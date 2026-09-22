import { tmpdir } from 'os'
import { sep, resolve as resolvePath } from 'path'
import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import type { RelayAgentExecutor, RelaySpawnRequest, RelayTurnInput } from '../../../packages/codesurf-relay/src'
import { getAgentPath, getShellEnvPath } from '../agent-paths'
import {
  buildHermesChatArgs,
  buildOpenClawAgentArgs,
  buildOpenCodeRunArgs,
  parseHermesOutput,
  parseHermesStreamJsonOutput,
  parseOpenClawOutput,
  parseOpenCodeRunOutput,
  sanitizeAgentCliDiagnostic,
} from '../agents/agent-cli-contracts'
import { resolveStoredPermission } from '../permissions'
import { CODESURF_HOME } from '../paths'
import {
  RELAY_SUBPROCESS_STDERR_MAX_BYTES,
  RELAY_SUBPROCESS_STDOUT_MAX_BYTES,
  runBoundedSubprocess,
  type BoundedSubprocessResult,
} from './bounded-subprocess'
import { createRelayProviderCancellation } from './provider-cancellation'

// Daemon-produced paths that should be intrinsically Read-allowed without
// requiring a workspace-level grant. These directories exist solely because
// the user attached, dropped, or sketched an image inside the chat tile —
// auto-allowing Reads from them matches user intent ("show this to the agent")
// and prevents the maddening per-attachment permission prompts.
//
// Scope: Read only. Write/Edit on these paths still go through the normal
// grant flow — the daemon shouldn't mutate user attachments without consent.
//
// Trust model: the producer (CodeSurf itself) is trusted. The consumer (the
// agent) is gated by the user's intent ("I attached this image"). Same
// pattern as ~/.fieldtheory/librarian/ in the Claude Code hook chain.
const DAEMON_AUTOREAD_PREFIXES: string[] = [
  resolvePath(CODESURF_HOME, 'chat-attachments') + sep,
  resolvePath(CODESURF_HOME, 'chat-vision') + sep,
  // Legacy compat: the pre-fix build wrote sketches under
  // os.tmpdir()/codesurf-chat-attach. Keep this in the allowlist until all
  // dist-electron bundles in the wild have been rebuilt with the fix that
  // moved sketches into CODESURF_HOME.
  resolvePath(tmpdir(), 'codesurf-chat-attach') + sep,
]

function isDaemonAutoReadablePath(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0) return false
  let resolved: string
  try { resolved = resolvePath(filePath) } catch { return false }
  return DAEMON_AUTOREAD_PREFIXES.some(prefix => resolved.startsWith(prefix))
}

const claudeSessions = new Map<string, string>()
const hermesSessions = new Map<string, string>()
const openClawSessions = new Map<string, string>()
const openCodeSessions = new Map<string, string>()
const OPENCLAW_AGENT_LIST_TIMEOUT_MS = 15_000
const OPENCLAW_AGENT_LIST_MAX_BUFFER_BYTES = 1024 * 1024

async function runRelayProviderCli(options: {
  label: string
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
  stdoutMaxBytes?: number
}): Promise<BoundedSubprocessResult> {
  return await runBoundedSubprocess({
    ...options,
    stdoutMaxBytes: options.stdoutMaxBytes
      ?? RELAY_SUBPROCESS_STDOUT_MAX_BYTES,
    stderrMaxBytes: RELAY_SUBPROCESS_STDERR_MAX_BYTES,
  })
}

function workspaceDirFromSpawnRequest(spawnRequest: RelaySpawnRequest): string | null {
  return typeof spawnRequest.metadata?.workspaceDir === 'string'
    ? spawnRequest.metadata.workspaceDir
    : typeof spawnRequest.metadata?.projectPath === 'string'
      ? spawnRequest.metadata.projectPath
      : typeof spawnRequest.metadata?.cwd === 'string'
        ? spawnRequest.metadata.cwd
        : null
}

function modeForClaude(mode?: string): string {
  const modeMap: Record<string, string> = {
    default: 'default',
    acceptEdits: 'acceptEdits',
    plan: 'plan',
    bypassPermissions: 'bypassPermissions',
  }
  return modeMap[mode ?? 'plan'] ?? 'plan'
}

function thinkingForClaude(thinking?: string): { type: string; budget_tokens?: number } {
  const thinkingMap: Record<string, { type: string; budget_tokens?: number }> = {
    adaptive: { type: 'adaptive' },
    none: { type: 'disabled' },
    low: { type: 'enabled', budget_tokens: 2048 },
    medium: { type: 'enabled', budget_tokens: 8192 },
    high: { type: 'enabled', budget_tokens: 32768 },
    max: { type: 'enabled', budget_tokens: 131072 },
  }
  return thinkingMap[thinking ?? 'adaptive'] ?? { type: 'adaptive' }
}

async function runClaudeTurn(
  participantId: string,
  spawnRequest: RelaySpawnRequest,
  input: RelayTurnInput,
  timeoutMs = 300_000,
  signal?: AbortSignal,
): Promise<string> {
  const cancellation = createRelayProviderCancellation('Claude', signal)
  const claudePermissionMode = modeForClaude(spawnRequest.mode)
  const workspaceDir = workspaceDirFromSpawnRequest(spawnRequest)
  const options: Options = {
    abortController: cancellation.abortController,
    model: spawnRequest.model ?? 'claude-sonnet-4-6',
    permissionMode: claudePermissionMode as any,
    thinking: thinkingForClaude(spawnRequest.thinking) as any,
    persistSession: true,
    includePartialMessages: false,
    ...(claudePermissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    ...(claudePermissionMode !== 'bypassPermissions' ? {
      // Background relay has no UI, so we can only consult the persisted
      // permission store — any tool without a standing allow-grant is
      // rejected. A `never` (persistent deny) grant now produces a
      // distinct, clearer message so the user knows why calls keep
      // failing and where to clear it.
      canUseTool: async (toolName: string, input: Record<string, unknown>, toolOptions: any) => {
        // ── Path-based auto-allow for daemon-produced attachments ──────
        // Read calls against ~/.codesurf/chat-attachments/ and chat-vision/
        // (and the legacy tmpdir path) bypass the stored-grant check.
        // These directories are produced exclusively by CodeSurf IPC
        // handlers in response to user actions (attaching / sketching),
        // so a Read against them is implicitly user-consented.
        if (toolName === 'Read' && typeof input?.file_path === 'string' && isDaemonAutoReadablePath(input.file_path)) {
          return { behavior: 'allow', updatedInput: input, toolUseID: toolOptions?.toolUseID }
        }

        const decision = resolveStoredPermission({
          provider: 'claude',
          toolName,
          title: typeof toolOptions?.title === 'string' ? toolOptions.title : null,
          description: typeof toolOptions?.description === 'string' ? toolOptions.description : null,
          blockedPath: typeof toolOptions?.blockedPath === 'string' ? toolOptions.blockedPath : null,
          workspaceDir,
        })

        if (decision === 'allow') {
          return { behavior: 'allow', updatedInput: input, toolUseID: toolOptions?.toolUseID }
        }
        if (decision === 'deny') {
          return {
            behavior: 'deny',
            message: `Permission for ${toolName} is set to Never. Clear it in Settings → Permissions to re-enable prompts.`,
            toolUseID: toolOptions?.toolUseID,
          }
        }

        return {
          behavior: 'deny',
          message: `Permission required for ${toolName}. Save a session, all-day, or all-time grant from an interactive chat before using this relay agent.`,
          toolUseID: toolOptions?.toolUseID,
        }
      },
    } : {}),
  }

  const existingSessionId = claudeSessions.get(participantId)
  if (existingSessionId) {
    options.resume = existingSessionId
  }

  const claudePath = getAgentPath('claude')
  if (claudePath) {
    ;(options as any).pathToClaudeCodeExecutable = claudePath
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    const q = query({ prompt: input.prompt, options })
    let text = ''

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        // Cancel the SDK subprocess so it stops running (and billing) instead of
        // finishing the turn in the background with its result silently discarded.
        cancellation.abortController.abort()
        reject(new Error(`Claude turn timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    })

    const queryPromise = (async () => {
      for await (const msg of q) {
        const sid = (msg as any).session_id
        if (sid) claudeSessions.set(participantId, sid)

        if (msg.type === 'assistant') {
          const blocks = (msg as any).message?.content ?? []
          const blockText = blocks
            .filter((block: { type?: string; text?: string }) => block.type === 'text' && typeof block.text === 'string')
            .map((block: { text?: string }) => block.text)
            .join('')
          if (blockText) text += blockText
        }

        if (msg.type === 'result') {
          const result = (msg as any).result
          if (typeof result === 'string' && result.trim()) return result
        }
      }
      return text
    })()

    return await Promise.race([
      queryPromise,
      timeoutPromise,
      cancellation.cancelled,
    ])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    cancellation.dispose()
  }
}

async function runCodexTurn(
  spawnRequest: RelaySpawnRequest,
  input: RelayTurnInput,
  timeoutMs = 300_000,
  signal?: AbortSignal,
): Promise<string> {
  const codexBin = getAgentPath('codex') || 'codex'
  const shellPath = getShellEnvPath()
  const workspaceDir = workspaceDirFromSpawnRequest(spawnRequest)
  const mode = spawnRequest.mode ?? 'default'
  const modeArgs = mode === 'bypassPermissions' || mode === 'full-access'
    ? ['--dangerously-bypass-approvals-and-sandbox']
    : mode === 'auto' || mode === 'full-auto'
      ? ['--full-auto']
      : mode === 'read-only' || mode === 'plan'
        ? ['--sandbox', 'read-only']
        : ['--sandbox', 'workspace-write']
  const result = await runRelayProviderCli({
    label: 'Codex',
    command: codexBin,
    args: [
      'exec',
      '--model', spawnRequest.model ?? 'gpt-5.3-codex',
      ...modeArgs,
      '--skip-git-repo-check',
      ...(workspaceDir ? ['-C', workspaceDir] : []),
      input.prompt,
    ],
    env: { ...process.env, ...(shellPath && { PATH: shellPath }) },
    timeoutMs,
    signal,
  })
  if (result.code !== 0) {
    throw new Error(sanitizeAgentCliDiagnostic(result.stderr.trim() || `Codex exited with ${result.code}`))
  }
  return result.stdout.trim()
}

async function runOpenCodeTurn(
  participantId: string,
  spawnRequest: RelaySpawnRequest,
  input: RelayTurnInput,
  timeoutMs = 300_000,
  signal?: AbortSignal,
): Promise<string> {
  const opencodeBin = getAgentPath('opencode') || 'opencode'
  const shellPath = getShellEnvPath()
  const workspaceDir = workspaceDirFromSpawnRequest(spawnRequest)
  const existingSessionId = openCodeSessions.get(participantId) ?? null
  const agent = typeof spawnRequest.metadata?.agent === 'string'
    ? spawnRequest.metadata.agent
    : typeof spawnRequest.metadata?.agentName === 'string'
      ? spawnRequest.metadata.agentName
      : null

  const args = buildOpenCodeRunArgs({
    prompt: input.prompt,
    model: spawnRequest.model,
    agent,
    sessionId: existingSessionId,
    cwd: workspaceDir,
    bypassPermissions: spawnRequest.mode === 'bypassPermissions',
  })
  const result = await runRelayProviderCli({
    label: 'OpenCode',
    command: opencodeBin,
    args,
    env: { ...process.env, ...(shellPath && { PATH: shellPath }) },
    timeoutMs,
    signal,
  })
  if (result.code !== 0) {
    throw new Error(sanitizeAgentCliDiagnostic(
      result.stderr.trim() || result.stdout.trim() || `OpenCode exited with ${result.code}`,
    ))
  }

  const parsed = parseOpenCodeRunOutput(result.stdout)
  if (parsed.sessionId) openCodeSessions.set(participantId, parsed.sessionId)
  return parsed.text || result.stdout.trim()
}

function normalizeOpenClawModelRef(model?: string | null): string {
  return (model ?? '').trim().toLowerCase()
}

type OpenClawAgentSummary = {
  id: string
  name?: string
  model?: string
  isDefault?: boolean
}

async function discoverOpenClawAgents(
  openclawBin: string,
  shellPath?: string | null,
  signal?: AbortSignal,
): Promise<OpenClawAgentSummary[]> {
  const result = await runRelayProviderCli({
    label: 'OpenClaw agent discovery',
    command: openclawBin,
    args: ['agents', 'list', '--json'],
    env: { ...process.env, ...(shellPath && { PATH: shellPath }) },
    timeoutMs: OPENCLAW_AGENT_LIST_TIMEOUT_MS,
    signal,
    stdoutMaxBytes: OPENCLAW_AGENT_LIST_MAX_BUFFER_BYTES,
  })
  if (result.code !== 0) return []
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim())
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value): OpenClawAgentSummary[] => {
      if (
        value === null
        || typeof value !== 'object'
        || typeof (value as { id?: unknown }).id !== 'string'
      ) {
        return []
      }
      const candidate = value as Record<string, unknown>
      return [{
        id: candidate.id as string,
        ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
        ...(typeof candidate.model === 'string' ? { model: candidate.model } : {}),
        ...(typeof candidate.isDefault === 'boolean'
          ? { isDefault: candidate.isDefault }
          : {}),
      }]
    })
  } catch {
    return []
  }
}

function selectOpenClawAgentId(
  agents: OpenClawAgentSummary[],
  preferredModel?: string | null,
): string | null {
  if (agents.length === 0) return 'main'

  const requested = normalizeOpenClawModelRef(preferredModel)
  const isStable = (id: string): boolean => !id.startsWith('mc-gateway-') && !/^lead-[0-9a-f-]+$/i.test(id)

  if (requested) {
    const directStable = agents.find(agent => isStable(agent.id) && normalizeOpenClawModelRef(agent.id) === requested)
    if (directStable) return directStable.id

    const directAny = agents.find(agent => normalizeOpenClawModelRef(agent.id) === requested)
    if (directAny) return directAny.id

    const exactStable = agents.find(agent => isStable(agent.id) && normalizeOpenClawModelRef(agent.model) === requested)
    if (exactStable) return exactStable.id

    const exactAny = agents.find(agent => normalizeOpenClawModelRef(agent.model) === requested)
    if (exactAny) return exactAny.id

    return null
  }

  return agents.find(agent => agent.isDefault)?.id ?? agents[0]?.id ?? 'main'
}

async function runOpenClawTurn(
  participantId: string,
  spawnRequest: RelaySpawnRequest,
  input: RelayTurnInput,
  timeoutMs = 300_000,
  signal?: AbortSignal,
): Promise<string> {
  const openclawBin = getAgentPath('openclaw') || 'openclaw'
  const shellPath = getShellEnvPath()
  const existingSessionId = openClawSessions.get(participantId) ?? null
  const agents = existingSessionId
    ? []
    : await discoverOpenClawAgents(openclawBin, shellPath, signal)
  const agentId = existingSessionId
    ? null
    : selectOpenClawAgentId(agents, spawnRequest.model)
  if (!existingSessionId && !agentId) {
    const available = agents
      .map(agent => agent.model || agent.id)
      .filter((value, index, all): value is string => typeof value === 'string' && value.trim().length > 0 && all.indexOf(value) === index)
    const details = available.length > 0 ? ` Available: ${available.join(', ')}` : ''
    throw new Error(`OpenClaw model must match exactly: ${spawnRequest.model}.${details}`)
  }

  const args = buildOpenClawAgentArgs({
    prompt: input.prompt,
    agentId,
    sessionId: existingSessionId,
    thinking: spawnRequest.thinking,
  })
  const result = await runRelayProviderCli({
    label: 'OpenClaw',
    command: openclawBin,
    args,
    env: { ...process.env, ...(shellPath && { PATH: shellPath }) },
    timeoutMs,
    signal,
  })
  if (result.code !== 0) {
    throw new Error(sanitizeAgentCliDiagnostic(
      result.stderr.trim() || result.stdout.trim() || `OpenClaw exited with ${result.code}`,
    ))
  }

  const parsed = parseOpenClawOutput(result.stdout)
  if (parsed.sessionId) openClawSessions.set(participantId, parsed.sessionId)
  return parsed.text || result.stdout.trim()
}

async function runHermesTurn(
  participantId: string,
  spawnRequest: RelaySpawnRequest,
  input: RelayTurnInput,
  timeoutMs = 300_000,
  signal?: AbortSignal,
): Promise<string> {
  const hermesBin = getAgentPath('hermes') || 'hermes'
  const shellPath = getShellEnvPath()

  // Map mode to Hermes toolsets. CodeSurf owns the context envelope, so Hermes
  // should not independently inject workspace rules unless a future UI exposes
  // that as an inspected choice.
  const modeMap: Record<string, string> = {
    'full': 'terminal,file,web,browser',
    'terminal': 'terminal,file',
    'web': 'web,browser',
    'query': '',
    'bypassPermissions': 'terminal,file,web,browser',
    'default': 'terminal,file',
    'plan': '',
  }
  const toolsets = modeMap[spawnRequest.mode ?? ''] ?? 'terminal,file'
  const existingSessionId = hermesSessions.get(participantId) ?? null
  const provider = typeof spawnRequest.metadata?.provider === 'string'
    ? spawnRequest.metadata.provider
    : null

  const args = buildHermesChatArgs({
    prompt: input.prompt,
    model: spawnRequest.model,
    provider,
    toolsets,
    resumeSessionId: existingSessionId,
    ignoreRules: true,
    bypassPermissions: spawnRequest.mode === 'bypassPermissions',
  })
  const result = await runRelayProviderCli({
    label: 'Hermes',
    command: hermesBin,
    args,
    env: { ...process.env, ...(shellPath && { PATH: shellPath }) },
    timeoutMs,
    signal,
  })
  if (result.code !== 0) {
    throw new Error(sanitizeAgentCliDiagnostic(result.stderr.trim() || `Hermes exited with ${result.code}`))
  }
  const parsed = parseHermesStreamJsonOutput(result.stdout)
  if (parsed.sessionId) hermesSessions.set(participantId, parsed.sessionId)
  // If --stream-json produced no parsable events (e.g. Hermes binary
  // predates the flag), fall back to the legacy text parser so the
  // relay turn returns something sensible.
  if (!parsed.text && (!parsed.raw || parsed.raw.length === 0)) {
    const legacy = parseHermesOutput(result.stdout)
    if (legacy.sessionId) hermesSessions.set(participantId, legacy.sessionId)
    return legacy.text
  }
  return parsed.text
}

class MainProcessRelayExecutor implements RelayAgentExecutor {
  constructor(
    private readonly participantId: string,
    private readonly spawnRequest: RelaySpawnRequest,
  ) {}

  async runTurn(
    input: RelayTurnInput,
    signal?: AbortSignal,
  ): Promise<string> {
    switch (this.spawnRequest.provider) {
      case 'claude':
        return runClaudeTurn(
          this.participantId,
          this.spawnRequest,
          input,
          this.spawnRequest.timeoutMs,
          signal,
        )
      case 'codex':
        return runCodexTurn(
          this.spawnRequest,
          input,
          this.spawnRequest.timeoutMs,
          signal,
        )
      case 'opencode':
        return runOpenCodeTurn(
          this.participantId,
          this.spawnRequest,
          input,
          this.spawnRequest.timeoutMs,
          signal,
        )
      case 'openclaw':
        return runOpenClawTurn(
          this.participantId,
          this.spawnRequest,
          input,
          this.spawnRequest.timeoutMs,
          signal,
        )
      case 'hermes':
        return runHermesTurn(
          this.participantId,
          this.spawnRequest,
          input,
          this.spawnRequest.timeoutMs,
          signal,
        )
      default:
        throw new Error(`Unsupported relay provider: ${this.spawnRequest.provider ?? 'unknown'}`)
    }
  }
}

export function createMainProcessRelayExecutor(participantId: string, spawnRequest: RelaySpawnRequest): RelayAgentExecutor {
  return new MainProcessRelayExecutor(participantId, spawnRequest)
}

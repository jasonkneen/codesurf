import { createInterface, type Interface as ReadlineInterface } from 'node:readline/promises'
import { stdin, stdout, stderr } from 'node:process'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createDaemonClient,
  type DaemonClient,
} from './client.js'
import {
  createDaemonManager,
  resolveDaemonScriptFromCandidates,
} from './manager.js'
import {
  DAEMON_PACKAGE_VERSION,
  defaultCodesurfHome,
} from './paths.js'
import type {
  DaemonChatJobEvent,
  DaemonChatJobRequest,
  DaemonChatJobState,
  DaemonPersona,
  DaemonToolPermissionDecision,
} from './types.js'
import {
  clearChatCliSession,
  readChatCliSession,
  readChatCliSessionStore,
  upsertChatCliSession,
  type ChatCliSession,
  type ChatCliSessionIdentity,
} from './chat-session-store.js'
import {
  resolvePersonaModelSeed,
  type PersonaModelSeed,
} from './persona-model-binding.js'

interface ChatCliRunOptions {
  appDir?: string
  homeDir?: string
  getAppVersion?: () => string
}

interface ParsedChatArgs {
  help: boolean
  listPersonas: boolean
  provider: string | null
  model: string | null
  mode: string | null
  /** Selected Persona id (from --persona / --agent), null when unset. */
  persona: string | null
  workspaceDir: string
  resume: boolean
  newSession: boolean
  message: string | null
}

interface ResolvedChatArgs extends ParsedChatArgs {
  provider: string
  model: string
  mode: string
  /** Resolved Persona id ('' = no persona). Sent as request.agentId. */
  agentId: string
}

interface ChatRunContext {
  client: DaemonClient
  homeDir: string
  args: ResolvedChatArgs
  workspaceId: string
  readline: ReadlineInterface | null
  currentJobId: string | null
  currentAbortController: AbortController | null
  cancelRequested: boolean
}

const DEFAULT_PROVIDER = 'claude'
const DEFAULT_MODELS: Record<string, string> = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-5.5',
  opencode: 'anthropic/claude-sonnet-4-6',
  hermes: 'openai-codex/gpt-5.5',
  omnigent: 'omnigent:default',
}
const DEFAULT_MODES: Record<string, string> = {
  claude: 'default',
  codex: 'default',
  opencode: 'default',
  hermes: 'full',
  omnigent: 'default',
}

function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

function resolveDaemonScriptPath(appDir?: string): string {
  const candidates = [
    ...(appDir ? [
      join(appDir, 'bin', 'codesurfd.mjs'),
      join(appDir, 'packages', 'codesurf-daemon', 'bin', 'codesurfd.mjs'),
    ] : []),
    join(packageRoot(), 'bin', 'codesurfd.mjs'),
    join(process.cwd(), 'bin', 'codesurfd.mjs'),
    join(process.cwd(), 'packages', 'codesurf-daemon', 'bin', 'codesurfd.mjs'),
  ]
  return resolveDaemonScriptFromCandidates(candidates)
}

function daemonVersionPin(): string {
  const pinned = process.env.CODESURF_DAEMON_VERSION_PIN?.trim()
  return pinned && pinned.length > 0 ? pinned : DAEMON_PACKAGE_VERSION
}

function nextArg(argv: string[], index: number, flag: string): { value: string; nextIndex: number } {
  const value = argv[index + 1]
  if (value == null || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return { value, nextIndex: index + 1 }
}

export function parseChatArgs(argv: string[]): ParsedChatArgs {
  const positional: string[] = []
  const parsed: ParsedChatArgs = {
    help: false,
    listPersonas: false,
    provider: null,
    model: null,
    mode: null,
    persona: null,
    workspaceDir: process.cwd(),
    resume: true,
    newSession: false,
    message: null,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const readValue = (flag: string): string => {
      const result = nextArg(argv, index, flag)
      index = result.nextIndex
      return result.value
    }

    if (arg === '--') {
      positional.push(...argv.slice(index + 1))
      break
    }

    if (arg === '--help' || arg === '-h' || arg === 'help') {
      parsed.help = true
    } else if (arg === '--list-personas' || arg === '--list-agents') {
      parsed.listPersonas = true
    } else if (arg === '--persona' || arg === '--agent') {
      parsed.persona = readValue(arg)
    } else if (arg.startsWith('--persona=')) {
      parsed.persona = arg.slice('--persona='.length)
    } else if (arg.startsWith('--agent=')) {
      parsed.persona = arg.slice('--agent='.length)
    } else if (arg === '--provider' || arg === '-p') {
      parsed.provider = readValue(arg)
    } else if (arg.startsWith('--provider=')) {
      parsed.provider = arg.slice('--provider='.length)
    } else if (arg === '--model' || arg === '-m') {
      parsed.model = readValue(arg)
    } else if (arg.startsWith('--model=')) {
      parsed.model = arg.slice('--model='.length)
    } else if (arg === '--mode') {
      parsed.mode = readValue(arg)
    } else if (arg.startsWith('--mode=')) {
      parsed.mode = arg.slice('--mode='.length)
    } else if (arg === '--workspace' || arg === '--cwd' || arg === '-C') {
      parsed.workspaceDir = readValue(arg)
    } else if (arg.startsWith('--workspace=')) {
      parsed.workspaceDir = arg.slice('--workspace='.length)
    } else if (arg.startsWith('--cwd=')) {
      parsed.workspaceDir = arg.slice('--cwd='.length)
    } else if (arg === '--resume') {
      parsed.resume = true
    } else if (arg === '--no-resume') {
      parsed.resume = false
    } else if (arg === '--new') {
      parsed.newSession = true
      parsed.resume = false
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown chat option: ${arg}`)
    } else {
      positional.push(arg)
    }
  }

  parsed.workspaceDir = resolve(parsed.workspaceDir)
  const message = positional.join(' ').trim()
  parsed.message = message.length > 0 ? message : null
  return parsed
}

/**
 * Resolve provider/model/mode with the model-precedence ladder:
 *   1. explicit --provider/--model  (wins)
 *   2. the selected persona's soft defaultBinding (personaSeed; best-effort)
 *   3. the saved session for THIS identity (provider/model/workspace AND persona)
 *   4. built-in defaults
 *
 * `agentId` (the selected persona) is resolved here and threaded into the session
 * identity so resume never crosses a persona change: the saved session is only
 * inherited when its agentId matches the currently-selected persona.
 */
export function resolveChatArgs(
  parsed: ParsedChatArgs,
  homeDir: string,
  personaSeed: PersonaModelSeed | null = null,
): ResolvedChatArgs {
  const agentId = String(parsed.persona ?? '').trim()
  let provider = String(parsed.provider ?? '').trim()
  let model = String(parsed.model ?? '').trim()
  const mode = String(parsed.mode ?? '').trim()

  // Layer 2: a selected persona's soft default seeds any field NOT set explicitly.
  if (personaSeed) {
    if (!provider && personaSeed.provider) provider = personaSeed.provider
    if (!model && personaSeed.model) model = personaSeed.model
  }

  // Layer 3: the saved session — only when nothing above set provider/model, and
  // only when the session matches BOTH the workspace AND the selected persona.
  if (!provider && !model && !parsed.newSession) {
    const store = readChatCliSessionStore(homeDir)
    if (store.activeKey) {
      const active = store.sessions[store.activeKey]
      if (active?.workspaceDir === parsed.workspaceDir && (active.agentId ?? '') === agentId) {
        provider = active.provider
        model = active.model
      }
    }
  }

  provider = provider || DEFAULT_PROVIDER
  model = model || DEFAULT_MODELS[provider] || DEFAULT_MODELS[DEFAULT_PROVIDER]

  return {
    ...parsed,
    agentId,
    provider,
    model,
    mode: mode || DEFAULT_MODES[provider] || 'default',
  }
}

function printChatHelp(): void {
  stdout.write(`
CodeSurf chat

Usage:
  codesurf chat [message]
  codesurf chat --persona polly "review this"
  codesurf chat --provider claude --model claude-sonnet-4-6
  codesurf chat --provider codex --model gpt-5.5 --mode default
  codesurf chat --list-personas

Options:
  -p, --provider <name>   claude, codex, opencode, hermes, or omnigent (default: claude)
  -m, --model <name>      Provider model name
      --mode <mode>       Provider permission/tool mode
      --persona <id>      Select a CodeSurf Persona; the daemon applies its
                          soul/tools/skills authoritatively (alias: --agent)
      --list-personas     List available personas (id, name, description)
  -C, --cwd <path>        Workspace directory (default: current directory)
      --workspace <path>  Alias for --cwd
      --resume            Resume the saved session for provider/model/workspace
      --no-resume         Start the turn without a saved session id
      --new               Clear the saved session for provider/model/workspace
  -h, --help              Show this help

If no message is provided and stdin is a TTY, CodeSurf opens an interactive loop.
`)
}

function createClient(options: ChatCliRunOptions): DaemonClient {
  const homeDir = options.homeDir ?? defaultCodesurfHome()
  const manager = createDaemonManager({
    homeDir,
    getAppVersion: options.getAppVersion ?? daemonVersionPin,
    resolveDaemonScriptPath: () => resolveDaemonScriptPath(options.appDir),
  })
  return createDaemonClient({
    ensureRunning: manager.ensureDaemonRunning,
    getStatus: manager.getDaemonStatus,
    invalidate: manager.invalidateDaemonCache,
    requestTimeoutMs: 20_000,
  })
}

function identityFor(args: ResolvedChatArgs): ChatCliSessionIdentity {
  return {
    provider: args.provider,
    model: args.model,
    workspaceDir: args.workspaceDir,
    agentId: args.agentId,
  }
}

/**
 * Build the daemon start request for a turn. SECURITY: this sends ONLY the
 * persona id (`agentId`) and NEVER an `agentMode`. The daemon resolves the
 * persona's tools/permissions authoritatively from trusted local sources; a
 * CLI-supplied `agentMode` would be exactly the trusted-payload injection vector
 * the daemon refuses, so this function must never set it.
 */
export function buildStartRequest(params: {
  args: ResolvedChatArgs
  prior: ChatCliSession | null
  message: string
  workspaceId: string
}): DaemonChatJobRequest {
  const { args, prior, message } = params
  const workspaceId = String(params.workspaceId ?? '').trim()
  if (!workspaceId) throw new Error('A registered workspace is required to start chat')
  const request: DaemonChatJobRequest = {
    provider: args.provider,
    model: args.model,
    mode: args.mode,
    runMode: 'foreground',
    workspaceId,
    workspaceDir: args.workspaceDir,
    sessionId: prior?.sessionId ?? null,
    messages: [{ role: 'user', content: message }],
  }
  if (args.agentId) request.agentId = args.agentId
  return request
}

function preview(value: unknown, maxLength = 2000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const normalized = String(text ?? '').trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trimEnd()}\n[truncated]` : normalized
}

function formatCommandEntries(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return ''
  return value.map((entry) => {
    const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
    const command = typeof record.command === 'string' ? record.command : record.label
    const output = typeof record.output === 'string' && record.output.trim()
      ? `\n${preview(record.output, 1200)}`
      : ''
    return `  $ ${String(command ?? 'command')}${output}`
  }).join('\n')
}

function formatFileChanges(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return ''
  return value.map((entry) => {
    const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
    const path = typeof record.path === 'string' ? record.path : 'file'
    const changeType = typeof record.changeType === 'string' ? record.changeType : 'update'
    const additions = Number(record.additions ?? 0)
    const deletions = Number(record.deletions ?? 0)
    return `  ${changeType} ${path} (+${additions}/-${deletions})`
  }).join('\n')
}

function formatToolName(event: DaemonChatJobEvent): string {
  return String(event.toolName ?? event.title ?? event.toolId ?? 'tool').trim() || 'tool'
}

function formatEvent(event: DaemonChatJobEvent): void {
  if (event.type === 'text') {
    stdout.write(String(event.text ?? ''))
    return
  }

  if (event.type === 'thinking_start') {
    stdout.write('\n[thinking]\n')
    return
  }

  if (event.type === 'thinking') {
    const text = String(event.text ?? '').trim()
    if (text) stdout.write(`\n[thinking] ${text}\n`)
    return
  }

  if (event.type === 'tool_permission_request') {
    return
  }

  if (event.type.startsWith('tool_')) {
    const toolName = formatToolName(event)
    if (event.type === 'tool_start') {
      stdout.write(`\n[tool] ${toolName} started\n`)
      return
    }
    if (event.type === 'tool_input') {
      const text = preview(event.text)
      if (text) stdout.write(`\n[tool input] ${toolName}\n${text}\n`)
      return
    }
    if (event.type === 'tool_use') {
      const input = preview(event.toolInput)
      stdout.write(`\n[tool] ${toolName}${input ? `\n${input}` : ''}\n`)
      return
    }
    if (event.type === 'tool_summary') {
      const text = preview(event.text)
      const commands = formatCommandEntries(event.commandEntries)
      const files = formatFileChanges(event.fileChanges)
      const body = [text, commands, files].filter(Boolean).join('\n')
      stdout.write(`\n[tool] ${toolName}${body ? `\n${body}` : ''}\n`)
      return
    }
    if (event.type === 'tool_progress') {
      const elapsedValue = Number(event.elapsed)
      const elapsed = Number.isFinite(elapsedValue) ? ` ${elapsedValue}s` : ''
      stdout.write(`\n[tool] ${toolName}${elapsed}\n`)
      return
    }
    if (event.type === 'tool_permission_resolved') {
      stdout.write(`\n[permission] ${toolName}: ${String(event.decision ?? 'answered')}\n`)
      return
    }
    stdout.write(`\n[${event.type}] ${toolName}\n`)
    return
  }

  if (event.type === 'error') {
    stderr.write(`\n[error] ${String(event.error ?? 'Unknown error')}\n`)
    return
  }

  if (event.type === 'done') {
    stdout.write('\n[done]\n')
  }
}

function isTerminalState(state: DaemonChatJobState | null): boolean {
  if (!state) return true
  return state.status !== 'running' && state.status !== 'queued'
}

function isTTY(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY)
}

async function ask(readline: ReadlineInterface, question: string): Promise<string> {
  return (await readline.question(question)).trim()
}

function normalizePermissionAnswer(value: string): DaemonToolPermissionDecision | null {
  const normalized = value.trim().toLowerCase()
  const aliases: Record<string, DaemonToolPermissionDecision> = {
    o: 'once',
    once: 'once',
    y: 'once',
    yes: 'once',
    s: 'session',
    session: 'session',
    t: 'today',
    today: 'today',
    f: 'forever',
    forever: 'forever',
    always: 'forever',
    d: 'deny',
    deny: 'deny',
    no: 'deny',
    n: 'never',
    never: 'never',
  }
  return aliases[normalized] ?? null
}

async function answerPermission(ctx: ChatRunContext, event: DaemonChatJobEvent): Promise<void> {
  const jobId = String(event.jobId ?? ctx.currentJobId ?? '').trim()
  const toolId = String(event.toolId ?? '').trim()
  const toolName = formatToolName(event)
  const title = String(event.title ?? toolName).trim()
  const description = String(event.description ?? '').trim()
  const blockedPath = String(event.blockedPath ?? '').trim()
  stdout.write(`\n[permission] ${title}\n`)
  if (description) stdout.write(`${description}\n`)
  if (blockedPath) stdout.write(`Path: ${blockedPath}\n`)

  let decision: DaemonToolPermissionDecision = 'deny'
  if (ctx.readline && isTTY()) {
    while (true) {
      const answer = await ask(ctx.readline, 'Allow? [o]nce/[s]ession/[t]oday/[f]orever/[d]eny/[n]ever: ')
      const normalized = normalizePermissionAnswer(answer)
      if (normalized) {
        decision = normalized
        break
      }
      stdout.write('Enter one of: once, session, today, forever, deny, never.\n')
    }
  } else {
    stderr.write('[permission] non-interactive input; denying tool request\n')
  }

  const result = await ctx.client.answerPermission({ jobId, toolId, decision })
  if (!result.ok) {
    stderr.write(`[permission] failed to answer ${toolName}: ${result.error ?? 'unknown error'}\n`)
  }
}

function updateSessionFromEvent(homeDir: string, args: ResolvedChatArgs, event: DaemonChatJobEvent, prior: ChatCliSession | null): ChatCliSession {
  return upsertChatCliSession(homeDir, {
    provider: args.provider,
    model: args.model,
    workspaceDir: args.workspaceDir,
    agentId: args.agentId,
    sessionId: typeof event.sessionId === 'string' && event.sessionId.trim()
      ? event.sessionId.trim()
      : (prior?.sessionId ?? null),
    jobId: typeof event.jobId === 'string' && event.jobId.trim()
      ? event.jobId.trim()
      : (prior?.jobId ?? null),
    lastSequence: Number.isFinite(event.sequence) ? Number(event.sequence) : (prior?.lastSequence ?? 0),
  })
}

function updateSessionFromState(homeDir: string, args: ResolvedChatArgs, state: DaemonChatJobState, prior: ChatCliSession | null): ChatCliSession {
  return upsertChatCliSession(homeDir, {
    provider: args.provider,
    model: args.model,
    workspaceDir: args.workspaceDir,
    agentId: args.agentId,
    sessionId: typeof state.sessionId === 'string' && state.sessionId.trim()
      ? state.sessionId.trim()
      : (prior?.sessionId ?? null),
    jobId: state.id,
    lastSequence: Number.isFinite(state.lastSequence) ? Number(state.lastSequence) : (prior?.lastSequence ?? 0),
  })
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function streamJob(ctx: ChatRunContext, initialSession: ChatCliSession): Promise<ChatCliSession> {
  let session = initialSession
  let terminalEventSeen = false

  while (true) {
    const jobId = String(session.jobId ?? '').trim()
    if (!jobId) return session

    const abortController = new AbortController()
    ctx.currentJobId = jobId
    ctx.currentAbortController = abortController

    try {
      await ctx.client.streamJobEvents({
        jobId,
        since: session.lastSequence,
        signal: abortController.signal,
        onParseError: error => {
          stderr.write(`[stream] parse error: ${error.message}\n`)
        },
        onEvent: async (event) => {
          session = updateSessionFromEvent(ctx.homeDir, ctx.args, event, session)
          if (event.type === 'tool_permission_request') {
            await answerPermission(ctx, event)
          } else {
            formatEvent(event)
          }
          if (event.type === 'done') terminalEventSeen = true
        },
      })
    } catch (error) {
      if (ctx.cancelRequested || abortController.signal.aborted) {
        return session
      }
      stderr.write(`[stream] ${error instanceof Error ? error.message : String(error)}\n`)
    } finally {
      if (ctx.currentAbortController === abortController) {
        ctx.currentAbortController = null
        ctx.currentJobId = null
      }
    }

    const state = await ctx.client.getJobState(jobId).catch(() => null)
    const stateLastSequence = Number(state?.lastSequence ?? 0)
    if (state && !terminalEventSeen && stateLastSequence > session.lastSequence) {
      await sleep(250)
      continue
    }
    if (state) {
      session = updateSessionFromState(ctx.homeDir, ctx.args, state, session)
    }
    if (terminalEventSeen || isTerminalState(state)) return session
    await sleep(500)
  }
}

async function startTurn(ctx: ChatRunContext, message: string): Promise<ChatCliSession> {
  const trimmed = message.trim()
  if (!trimmed) {
    return readChatCliSession(ctx.homeDir, identityFor(ctx.args))
      ?? upsertChatCliSession(ctx.homeDir, {
        provider: ctx.args.provider,
        model: ctx.args.model,
        workspaceDir: ctx.args.workspaceDir,
        agentId: ctx.args.agentId,
        sessionId: null,
        jobId: null,
        lastSequence: 0,
      })
  }

  const prior = ctx.args.resume ? readChatCliSession(ctx.homeDir, identityFor(ctx.args)) : null
  const request = buildStartRequest({
    args: ctx.args,
    prior,
    message: trimmed,
    workspaceId: ctx.workspaceId,
  })

  const job = await ctx.client.startChatJob(request)
  const session = upsertChatCliSession(ctx.homeDir, {
    provider: ctx.args.provider,
    model: ctx.args.model,
    workspaceDir: ctx.args.workspaceDir,
    agentId: ctx.args.agentId,
    sessionId: prior?.sessionId ?? job.sessionId ?? null,
    jobId: job.id,
    lastSequence: 0,
  })
  return await streamJob(ctx, session)
}

async function resumeActiveStoredJob(ctx: ChatRunContext): Promise<void> {
  if (!ctx.args.resume) return
  const session = readChatCliSession(ctx.homeDir, identityFor(ctx.args))
  const jobId = String(session?.jobId ?? '').trim()
  if (!session || !jobId) return

  const state = await ctx.client.getJobState(jobId).catch(() => null)
  if (!state) return
  if (state.status === 'running' || state.status === 'queued' || Number(state.lastSequence ?? 0) > session.lastSequence) {
    stdout.write(`[resume] ${jobId}\n`)
    await streamJob(ctx, session)
  }
}

async function readStdinMessage(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

function installSigintHandler(ctx: ChatRunContext): () => void {
  const handler = (): void => {
    const jobId = ctx.currentJobId
    if (!jobId) {
      ctx.readline?.close()
      process.exit(130)
    }
    ctx.cancelRequested = true
    stderr.write('\n[cancel] cancelling daemon chat job\n')
    void ctx.client.cancelJob(jobId)
      .catch(error => {
        stderr.write(`[cancel] ${error instanceof Error ? error.message : String(error)}\n`)
      })
      .finally(() => {
        ctx.currentAbortController?.abort()
      })
  }
  process.on('SIGINT', handler)
  return () => {
    process.off('SIGINT', handler)
  }
}

/** Print the persona list (id + name + description) for `--list-personas`. */
async function listPersonasCommand(client: DaemonClient, workspaceDir: string): Promise<number> {
  try {
    const result = await client.listPersonas({ workspaceDir })
    const personas = Array.isArray(result?.personas) ? result.personas : []
    if (personas.length === 0) {
      stdout.write('No personas available.\n')
      return 0
    }
    for (const persona of personas) {
      const id = String(persona.id ?? '').trim()
      if (!id) continue
      const name = String(persona.name ?? '').trim()
      const description = String(persona.description ?? '').trim()
      stdout.write(`${id}${name ? `  ${name}` : ''}\n`)
      if (description) stdout.write(`    ${description}\n`)
    }
    return 0
  } catch (error) {
    stderr.write(`[personas] ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/**
 * Best-effort soft model seed for the selected persona. Fetches the read-only
 * persona list and reads the persona's `defaultBinding`. NEVER required for
 * correctness or security: the request always carries the agentId regardless,
 * and the daemon resolves tools/permissions authoritatively. A list failure or
 * an id absent from the list simply yields no seed (provider/model fall through
 * to session/defaults).
 */
async function fetchPersonaModelSeed(
  client: DaemonClient,
  agentId: string,
  workspaceDir: string,
): Promise<PersonaModelSeed | null> {
  try {
    const result = await client.listPersonas({ workspaceDir })
    const personas: DaemonPersona[] = Array.isArray(result?.personas) ? result.personas : []
    const persona = personas.find(entry => String(entry.id ?? '').trim() === agentId)
    return persona ? resolvePersonaModelSeed(persona) : null
  } catch {
    return null
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path)
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error(`Chat workspace is not a directory: ${path}`)
  }
  return canonical
}

async function resolveRegisteredChatWorkspace(client: DaemonClient, workspaceDir: string): Promise<string> {
  const canonicalRoot = await canonicalDirectory(workspaceDir)
  const workspaces = await client.listWorkspaces()
  for (const workspace of workspaces) {
    try {
      if (await canonicalDirectory(workspace.path) === canonicalRoot) return workspace.id
    } catch {
      // Ignore stale registry entries and continue to an exact usable root.
    }
  }
  const created = await client.createWorkspaceWithPath(
    basename(canonicalRoot) || 'Workspace',
    canonicalRoot,
  )
  if (!created?.id || await canonicalDirectory(created.path) !== canonicalRoot) {
    throw new Error('The daemon did not register the requested chat workspace')
  }
  return created.id
}

async function interactiveLoop(ctx: ChatRunContext): Promise<void> {
  if (!ctx.readline) return
  const personaLabel = ctx.args.agentId ? ` [persona: ${ctx.args.agentId}]` : ''
  stdout.write(`CodeSurf chat ${ctx.args.provider}/${ctx.args.model}${personaLabel} in ${ctx.args.workspaceDir}\n`)
  while (true) {
    const line = await ask(ctx.readline, 'codesurf> ')
    const command = line.toLowerCase()
    if (command === '/exit' || command === '/quit' || command === 'exit' || command === 'quit') return
    if (command === '/new') {
      clearChatCliSession(ctx.homeDir, identityFor(ctx.args))
      stdout.write('[session] cleared\n')
      continue
    }
    if (!line.trim()) continue
    ctx.cancelRequested = false
    await startTurn(ctx, line)
  }
}

export async function runCodesurfChatCli(argv: string[], options: ChatCliRunOptions = {}): Promise<number> {
  const parsed = parseChatArgs(argv)
  if (parsed.help) {
    printChatHelp()
    return 0
  }

  const homeDir = options.homeDir ?? defaultCodesurfHome()
  const client = createClient({ ...options, homeDir })

  if (parsed.listPersonas) {
    return await listPersonasCommand(client, parsed.workspaceDir)
  }

  // Best-effort: seed provider/model from the selected persona's soft binding.
  // The agentId is sent regardless; this only affects the cosmetic model default.
  const selectedAgentId = String(parsed.persona ?? '').trim()
  const personaSeed = selectedAgentId
    ? await fetchPersonaModelSeed(client, selectedAgentId, parsed.workspaceDir)
    : null

  const args = resolveChatArgs(parsed, homeDir, personaSeed)
  const workspaceId = await resolveRegisteredChatWorkspace(client, args.workspaceDir)
  if (args.newSession) clearChatCliSession(homeDir, identityFor(args))
  const readline = isTTY() && !args.message
    ? createInterface({ input: stdin, output: stdout })
    : null
  const ctx: ChatRunContext = {
    client,
    homeDir,
    args,
    workspaceId,
    readline,
    currentJobId: null,
    currentAbortController: null,
    cancelRequested: false,
  }
  const removeSigintHandler = installSigintHandler(ctx)

  try {
    if (args.message) {
      await startTurn(ctx, args.message)
    } else if (!stdin.isTTY) {
      const message = await readStdinMessage()
      if (!message) throw new Error('No chat message provided on stdin')
      await startTurn(ctx, message)
    } else {
      await resumeActiveStoredJob(ctx)
      await interactiveLoop(ctx)
    }
    return 0
  } finally {
    removeSigintHandler()
    readline?.close()
  }
}

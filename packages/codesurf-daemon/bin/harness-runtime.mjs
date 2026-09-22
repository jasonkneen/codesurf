// Harness backend for the CodeSurf daemon.
//
// Runs Claude Code / Codex through @ai-sdk/harness against a LOCAL sandbox
// provider (no Vercel cloud). Lives only in the daemon process, which is raw
// Node ESM spawned separately from the Electron renderer — so harness's
// ai@7-canary never meets the renderer's ai@6. See memory:
// project_harness_local_sandbox.
//
// runHarnessJob mirrors runClaudeJob's contract in chat-jobs.mjs: it takes
// (job, request, workspaceDir, instructionPrompt) plus an appendEvent sink, and
// emits the same normalized event vocabulary (text / thinking / tool_start /
// tool_input / tool_summary / session / error / done).

import { spawn as nodeSpawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { mkdirSync, symlinkSync, rmSync, existsSync, lstatSync } from 'node:fs'
import { isAbsolute, join, dirname } from 'node:path'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { claudeCode } from '@ai-sdk/harness-claude-code'
import { codex } from '@ai-sdk/harness-codex'
import { PI_HARNESS_UNAVAILABLE_ERROR } from './harness-policy.mjs'
import {
  createSessionWorktree,
  changedFiles,
  ignoredCreated,
  applyPaths,
  removeWorktree,
} from './harness-worktree.mjs'
import {
  isToolAllowedByAgent,
  resolveAgentToolAllowList,
  harnessReadsUnenforceable,
  HARNESS_READS_UNENFORCEABLE_ERROR,
} from './agent-mode-tools.mjs'
import { CHAT_CONTEXT_LIMITS } from '../dist/context-composer.js'

// Re-exported so existing importers (test/daemon/chat-jobs-agent-mode.test.mjs)
// keep resolving `isToolAllowedByAgent` from here. Source of truth and the
// null/[]/names semantics live in agent-mode-tools.mjs.
export { isToolAllowedByAgent } from './agent-mode-tools.mjs'
export { PI_HARNESS_UNAVAILABLE_ERROR }

export const HARNESS_SUPPORTED_PROVIDERS = new Set(['claude', 'codex'])

// Auth strategy: KEEP the real $HOME (inherited) so the Claude/Codex CLI finds
// the user's existing OAuth login / keychain credentials. The harness adapter's
// own auth path is API-key/gateway only (createClaudeCode({auth})), which OAuth
// desktop users don't have — so we cannot override HOME without breaking login.
//
// "Bind project" mapping (DETERMINISTIC): the framework composes the agent's
// cwd as <defaultWorkingDirectory>/<harnessId>-<sessionId>. We set
// defaultWorkingDirectory to an isolated dir (so .agent-runs/bridge bookkeeping
// stays out of the user's repo) and pre-create that composed child as a SYMLINK
// to the real workspace — so the agent's cwd IS the project and relative file
// ops land in the user's actual files, by filesystem construction rather than by
// trusting the model to follow a path instruction.
function sanitizeSessionId(id) {
  return String(id || 'session').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'session'
}

function bindWorkspace(sandboxBaseDir, harnessId, sessionId, workspaceDir) {
  const composed = join(sandboxBaseDir, `${harnessId}-${sessionId}`)
  try {
    if (existsSync(composed) || isSymlink(composed)) rmSync(composed, { recursive: true, force: true })
    symlinkSync(workspaceDir, composed)
  } catch (error) {
    throw new Error(`Failed to bind the harness workspace: ${errText(error)}`)
  }
  return composed
}

function isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink() } catch { return false }
}

function resolveHarness(provider) {
  if (provider === 'claude') return claudeCode
  if (provider === 'codex') return codex
  return null
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

const resolvePath = (cwd, p) => (isAbsolute(p) ? p : join(cwd, p))

// Minimal Experimental_SandboxSession over host child_process + fs. Every
// spawned child is tracked so the session can reap the bridge + agent process
// tree on destroy (the spike's gap #3).
class LocalSandboxSession {
  constructor(cwd, children) {
    this.cwd = cwd
    this._children = children ?? new Set()
  }

  _env(extra) {
    // Inherit the real environment (incl. $HOME) so the CLI keeps the user's
    // OAuth/keychain auth. cwd is set per-command to the workspace.
    return { ...process.env, ...extra }
  }

  get description() {
    return `Local host shell environment.\nCurrent working directory: ${this.cwd}`
  }

  _track(child) {
    this._children.add(child)
    child.on('close', () => this._children.delete(child))
    return child
  }

  async run({ command, workingDirectory, env, abortSignal }) {
    abortSignal?.throwIfAborted()
    const cwd = workingDirectory ? resolvePath(this.cwd, workingDirectory) : this.cwd
    return await new Promise((resolve, reject) => {
      const child = this._track(nodeSpawn('bash', ['-c', command], { cwd, env: this._env(env) }))
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', d => (stdout += d))
      child.stderr.on('data', d => (stderr += d))
      const onAbort = () => child.kill()
      abortSignal?.addEventListener('abort', onAbort, { once: true })
      child.on('error', reject)
      child.on('close', code => {
        abortSignal?.removeEventListener('abort', onAbort)
        resolve({ exitCode: code ?? 0, stdout, stderr })
      })
    })
  }

  async spawn({ command, workingDirectory, env, abortSignal }) {
    abortSignal?.throwIfAborted()
    const cwd = workingDirectory ? resolvePath(this.cwd, workingDirectory) : this.cwd
    const child = this._track(nodeSpawn('bash', ['-c', command], { cwd, env: this._env(env) }))
    abortSignal?.addEventListener('abort', () => child.kill(), { once: true })
    const exitPromise = new Promise(r => child.on('close', code => r({ exitCode: code ?? 0 })))
    return {
      pid: child.pid,
      stdout: Readable.toWeb(child.stdout),
      stderr: Readable.toWeb(child.stderr),
      wait: () => exitPromise,
      kill: async () => child.kill(),
    }
  }

  async readBinaryFile({ path }) {
    try {
      const b = await readFile(resolvePath(this.cwd, path))
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
    } catch (e) {
      if (e?.code === 'ENOENT') return null
      throw e
    }
  }

  async readFile(o) {
    const b = await this.readBinaryFile(o)
    return b == null ? null : new ReadableStream({ start(c) { c.enqueue(b); c.close() } })
  }

  async readTextFile({ path, encoding = 'utf-8', startLine, endLine }) {
    const b = await this.readBinaryFile({ path })
    if (b == null) return null
    let t = Buffer.from(b).toString(encoding)
    if (startLine != null || endLine != null) {
      const L = t.split('\n')
      t = L.slice((startLine ?? 1) - 1, endLine ?? L.length).join('\n')
    }
    return t
  }

  async writeBinaryFile({ path, content }) {
    const r = resolvePath(this.cwd, path)
    await mkdir(dirname(r), { recursive: true })
    await writeFile(r, content)
  }

  async writeFile({ path, content }) {
    const rd = content.getReader()
    const chunks = []
    for (;;) {
      const { value, done } = await rd.read()
      if (done) break
      if (value) chunks.push(value)
    }
    await this.writeBinaryFile({ path, content: Buffer.concat(chunks) })
  }

  async writeTextFile({ path, content, encoding = 'utf-8' }) {
    await this.writeBinaryFile({ path, content: Buffer.from(content, encoding) })
  }
}

class LocalNetworkSandboxSession extends LocalSandboxSession {
  constructor({ cwd, port }) {
    const children = new Set()
    super(cwd, children)
    this.id = randomUUID()
    this.defaultWorkingDirectory = cwd
    this.ports = [port]
  }

  getPortUrl = async ({ port, protocol }) => `${protocol ?? 'http'}://127.0.0.1:${port}`

  stop = async () => {
    for (const child of this._children) {
      try { child.kill() } catch {}
    }
    this._children.clear()
  }

  destroy = async () => { await this.stop() }

  restricted() {
    return new LocalSandboxSession(this.cwd, this._children)
  }
}

export class LocalHostSandboxProvider {
  specificationVersion = 'harness-sandbox-v1'
  providerId = 'localhost-sandbox'

  constructor({ baseDir }) {
    this.baseDir = baseDir
    mkdirSync(this.baseDir, { recursive: true })
  }

  createSession = async (options) => {
    options?.abortSignal?.throwIfAborted()
    const port = await reserveLoopbackPort()
    const session = new LocalNetworkSandboxSession({ cwd: this.baseDir, port })
    if (options?.onFirstCreate) {
      await options.onFirstCreate(session.restricted(), { abortSignal: options?.abortSignal })
    }
    return session
  }
}

function errText(error) {
  if (error == null) return 'Unknown harness error'
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try { return JSON.stringify(error) } catch { return String(error) }
}

function promptFromMessage(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(p => (typeof p === 'string' ? p : p?.text ?? '')).join('')
  }
  return String(content ?? '')
}

// Maps an AI SDK StreamTextResult.fullStream into the daemon event vocabulary.
// Exported so the self-test can exercise it against a real run.
export async function pumpHarnessStream(stream, jobId, appendEvent) {
  const toolNames = new Map()
  const pendingApprovals = []
  let sawText = false
  for await (const part of stream) {
    switch (part.type) {
      case 'text-delta':
        if (part.text) { sawText = true; await appendEvent(jobId, { type: 'text', text: part.text }) }
        break
      case 'reasoning-start':
        await appendEvent(jobId, { type: 'thinking_start' })
        break
      case 'reasoning-delta':
        if (part.text) await appendEvent(jobId, { type: 'thinking', text: part.text })
        break
      case 'tool-call': {
        const toolId = part.toolCallId ?? randomUUID()
        toolNames.set(toolId, part.toolName)
        await appendEvent(jobId, { type: 'tool_start', toolId, toolName: part.toolName })
        const input = typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}, null, 2)
        if (input && input !== '{}') await appendEvent(jobId, { type: 'tool_input', toolId, text: input })
        break
      }
      case 'tool-result': {
        const toolId = part.toolCallId ?? randomUUID()
        const out = part.output
        const text = typeof out === 'string' ? out : JSON.stringify(out ?? {}, null, 2)
        await appendEvent(jobId, { type: 'tool_summary', toolId, toolName: toolNames.get(toolId) ?? part.toolName, text })
        break
      }
      case 'tool-approval-request':
        // The agent wants to run a tool that needs the user's OK. Collect it; the
        // caller surfaces each via the daemon's approval prompt, then resumes the
        // turn with the decision. `isAutomatic` requests are resolved by the
        // runtime itself and must NOT be re-asked.
        if (!part.isAutomatic) pendingApprovals.push({ approvalId: part.approvalId, toolCall: part.toolCall })
        break
      case 'error':
        await appendEvent(jobId, { type: 'error', error: errText(part.error) })
        break
      default:
        // text-start/text-end/reasoning-end/start/start-step/finish-step/finish
        // and file-change carry no user-visible payload we surface yet. Gitignored
        // writes are recovered from the worktree via ignoredCreated() at apply.
        break
    }
  }
  return { sawText, pendingApprovals }
}

// Checkpoint the pre-turn state, then apply the agent's worktree changes back to
// the live workspace. Called only on a successful turn, before `done`.
const IGNORED_APPLY_CAP = 500

async function commitWorktree(job, worktree, appendEvent, createCheckpoint) {
  let tracked = []
  let ignored = []
  try { tracked = changedFiles(worktree) } catch {}
  try { ignored = ignoredCreated(worktree) } catch {}
  if (!tracked.length && !ignored.length) return

  // Apply git-tracked changes plus gitignored files the agent created (which
  // git's diff drops). Guard against a pathological flood (e.g. the agent ran a
  // build that produced node_modules): past the cap, surface a warning instead
  // of silently dumping thousands of files into the user's repo.
  const applyIgnored = ignored.length <= IGNORED_APPLY_CAP
  const relToApply = applyIgnored ? [...new Set([...tracked, ...ignored])] : tracked
  const absToApply = relToApply.map(r => join(worktree.repo, r))

  // The live workspace is still at its pre-turn state here, so this checkpoint
  // captures the correct (pre-edit) content and plugs into the existing undo.
  if (typeof createCheckpoint === 'function' && absToApply.length) {
    try { await createCheckpoint('harness-turn', absToApply) } catch {}
  }

  const result = applyPaths(worktree, relToApply)
  const toolId = `harness-apply-${job.id}`
  await appendEvent(job.id, { type: 'tool_start', toolId, toolName: 'Workspace updated' })
  if (result.ok) {
    const conflictNote = result.conflicts?.length
      ? ` (${result.conflicts.length} file(s) had concurrent edits and were overwritten)`
      : ''
    const ignoredNote = applyIgnored
      ? ''
      : ` WARNING: ${ignored.length} gitignored files were created and NOT auto-applied — review the session worktree.`
    await appendEvent(job.id, {
      type: 'tool_summary',
      toolId,
      toolName: 'Workspace updated',
      text: `Applied ${relToApply.length} file change(s) to the workspace${conflictNote}.${ignoredNote}`,
    })
  } else {
    await appendEvent(job.id, { type: 'error', error: `Failed to apply harness changes: ${result.error}` })
  }
}

export function createHarnessRunner({ homeDir, createAgent, bindWorkspace: bindWorkspaceImpl = bindWorkspace } = {}) {
  const baseDir = join(homeDir, 'harness', 'sessions')
  const worktreeRoot = join(homeDir, 'harness', 'worktrees')
  mkdirSync(baseDir, { recursive: true })
  mkdirSync(worktreeRoot, { recursive: true })
  // Injectable for tests: lets a fake agent drive a scripted stream without a
  // sandbox/bridge/model. Defaults to the real HarnessAgent.
  const makeAgent = createAgent || (opts => new HarnessAgent(opts))

  async function runHarnessJob(job, request, workspaceDir, _instructionPrompt, { appendEvent, createCheckpoint, awaitToolPermission, contextPrompt } = {}) {
    if (request.provider === 'pi') {
      await appendEvent(job.id, { type: 'error', error: PI_HARNESS_UNAVAILABLE_ERROR })
      await appendEvent(job.id, { type: 'done' })
      return
    }

    const lastUserMsg = [...(request.messages ?? [])].reverse().find(m => m.role === 'user')
    if (!lastUserMsg) {
      await appendEvent(job.id, { type: 'error', error: 'No user message' })
      await appendEvent(job.id, { type: 'done' })
      return
    }

    const harness = resolveHarness(request.provider)
    if (!harness) {
      await appendEvent(job.id, { type: 'error', error: `Harness backend does not support provider: ${request.provider}` })
      await appendEvent(job.id, { type: 'done' })
      return
    }

    // PROVIDER-AWARE PERMISSION GUARD (A-PR1 #2c): the @ai-sdk/harness-codex
    // adapter cannot honor CodeSurf's 4 Codex permission modes — its doStart
    // throws on any permissionMode other than 'allow-all', and its bridge
    // hardcodes sandboxMode:'danger-full-access' + approvalPolicy:'never'. So the
    // harness can ONLY run Codex with full access, which would silently ignore a
    // user's read-only/default selection. chat-jobs.runJob therefore routes Codex
    // to the native `codex exec` CLI (which honors all 4 modes) even when the
    // harness is enabled. This guard is defense-in-depth: if a Codex job ever
    // reaches here, fail with a clear, honest message instead of the cryptic
    // upstream HarnessCapabilityUnsupportedError (or a silent full-access run).
    if (request.provider === 'codex') {
      await appendEvent(job.id, {
        type: 'error',
        error: 'Codex cannot run through the harness backend: its adapter only supports full-access (it cannot honor read-only/default/auto permission modes). Codex must use the native codex exec path.',
      })
      await appendEvent(job.id, { type: 'done' })
      return
    }

    const abortController = new AbortController()
    job.cancel = () => abortController.abort()

    // Keep harness bookkeeping (.agent-runs, bridge files) in an ISOLATED dir so
    // it never pollutes the user's project; the composed cwd child is symlinked
    // to the bind target so the agent edits real files there.
    const hasWorkspace = typeof workspaceDir === 'string' && workspaceDir.trim()
    const sessionId = sanitizeSessionId(request.sessionId || job.id)
    const sandboxBaseDir = join(baseDir, `${request.provider}-${job.id}`)
    mkdirSync(sandboxBaseDir, { recursive: true })

    // Run the turn against an isolated git worktree snapshot of the current
    // workspace state, so edits stay contained until the turn succeeds. On a
    // non-git workspace this is null and we bind the live workspace directly.
    let worktree = null
    if (hasWorkspace) {
      try { worktree = createSessionWorktree({ workspaceDir, worktreeRoot, sessionId }) } catch { worktree = null }
    }
    const bindTarget = worktree ? worktree.path : (hasWorkspace ? workspaceDir : null)
    if (bindTarget) {
      try {
        bindWorkspaceImpl(sandboxBaseDir, harness.harnessId, sessionId, bindTarget)
      } catch (error) {
        try { removeWorktree(worktree) } catch {}
        await appendEvent(job.id, { type: 'error', error: errText(error) })
        await appendEvent(job.id, { type: 'done' })
        return
      }
    }

    // Agent-definition tools allow-list (AgentMode.tools).
    //   null/absent → unrestricted     []  → deny-all     [names] → restricted
    //
    // ENFORCEMENT BOUNDARY (honest limitation, see PR #8 description):
    // The @ai-sdk/harness adapters (claude-code/codex) expose only three
    // permission modes for their *built-in* tools — allow-reads | allow-edits |
    // allow-all — and there is NO host hook that fires BEFORE the adapter's own
    // auto-approve decision for a built-in. The adapter's `toolApproval` config
    // can deny a tool at dispatch, but ONLY for custom *host-defined* tools, not
    // the adapter's native Read/Write/Bash. So a built-in that the active mode
    // auto-approves never emits an interceptable approval request, and the host
    // cannot stop it. We therefore enforce at the EARLIEST point the harness
    // allows — the approval loop below denies any pausing tool not on the list —
    // and MINIMISE the auto-approved set by forcing the most restrictive gated
    // mode (allow-reads) whenever a list is present (downgrading allow-all AND
    // allow-edits). That makes every write/edit/exec tool enforceable.
    // RESIDUAL GAP: reads are auto-approved under allow-reads (the strictest
    // mode available), so an allow-list that *excludes* Read cannot block reads
    // without an upstream harness change (a stricter "ask-all" mode, or routing
    // built-ins through host-defined tools). Tradeoff of the downgrade: an
    // *allowed* Write/Edit now surfaces an approval prompt instead of being
    // auto-approved under acceptEdits.
    const agentToolAllowList = resolveAgentToolAllowList(request.agentMode)

    // A-PR1 BLOCKING-2 (uniform fail-closed): the harness auto-approves built-in
    // reads under allow-reads (the strictest selectable mode) and exposes no
    // pre-approve host hook for them, so an allow-list that forbids reads (the
    // literal deny-all [], or any list excluding Read) CANNOT be honored here.
    // Refuse to launch rather than run read-capable while claiming reads are
    // denied — the same honest contract as the Codex deny-all fail-closed.
    if (harnessReadsUnenforceable(agentToolAllowList)) {
      await appendEvent(job.id, { type: 'error', error: HARNESS_READS_UNENFORCEABLE_ERROR })
      await appendEvent(job.id, { type: 'done' })
      return
    }

    // Permission mode → harness gating. Interactive per-tool approval is wired
    // (see the approval loop below), so gated modes raise real prompts the user
    // answers instead of stalling:
    //   bypassPermissions → allow-all   (no prompts)
    //   acceptEdits       → allow-edits (edits auto-approved; exec asks)
    //   default/plan/…    → allow-reads (reads auto; edits + exec ask)
    let permissionMode = request.mode === 'bypassPermissions'
      ? 'allow-all'
      : request.mode === 'acceptEdits'
        ? 'allow-edits'
        : 'allow-reads'
    if (agentToolAllowList != null && permissionMode !== 'allow-reads') {
      // A list is present ([] deny-all or [names]): force the strictest gated
      // mode so the maximum set of tools (everything but reads) surfaces for the
      // approval-loop deny below. Covers both allow-all and allow-edits.
      permissionMode = 'allow-reads'
    }

    // The job boundary already composed persona, memory, skills, conventions,
    // async guidance, and peers. Harness must consume that one prompt exactly
    // once rather than rebuilding a partial variant from legacy fields. The
    // sandbox binds cwd structurally, so no workspace path is model-visible.
    const instructions = typeof contextPrompt === 'string' ? contextPrompt.trim() : ''
    if (Buffer.byteLength(instructions, 'utf8') > CHAT_CONTEXT_LIMITS.aggregateBytes) {
      try { removeWorktree(worktree) } catch {}
      await appendEvent(job.id, {
        type: 'error',
        error: `Harness context exceeds ${CHAT_CONTEXT_LIMITS.aggregateBytes} UTF-8 bytes`,
      })
      await appendEvent(job.id, { type: 'done' })
      return
    }
    const agent = makeAgent({
      harness,
      sandbox: new LocalHostSandboxProvider({ baseDir: sandboxBaseDir }),
      permissionMode,
      ...(instructions ? { instructions } : {}),
    })

    let session = null
    try {
      session = await agent.createSession({
        sessionId,
        abortSignal: abortController.signal,
      })
      if (session.sessionId) {
        await appendEvent(job.id, { type: 'session', sessionId: session.sessionId })
      }

      let result = await agent.stream({
        session,
        prompt: promptFromMessage(lastUserMsg),
        abortSignal: abortController.signal,
      })

      // Drain the turn. If the agent pauses to ask permission for a tool, surface
      // each request through the daemon's approval prompt (the same UI the native
      // providers use), then resume the turn with the user's decisions. Repeats
      // until the turn finishes with no outstanding approvals.
      for (let round = 0; round < 100; round++) {
        const stream = result.fullStream ?? result.stream
        const { pendingApprovals } = await pumpHarnessStream(stream, job.id, appendEvent)
        if (!pendingApprovals.length) break

        const continuations = []
        for (const ap of pendingApprovals) {
          const requestedTool = ap.toolCall?.toolName ?? 'tool'
          let decision = 'deny'
          if (!isToolAllowedByAgent(requestedTool, agentToolAllowList)) {
            // Tool is outside the agent definition's allow-list: deny without
            // prompting the user. This is the real enforcement of AgentMode.tools.
            decision = 'deny'
            await appendEvent(job.id, {
              type: 'tool_summary',
              toolId: ap.approvalId,
              toolName: requestedTool,
              text: `Blocked by agent definition: "${requestedTool}" is not in the allowed tools list.`,
            })
          } else if (typeof awaitToolPermission === 'function') {
            try {
              decision = await awaitToolPermission(ap.approvalId, {
                provider: request.provider,
                toolName: requestedTool,
                title: null,
                description: null,
                blockedPath: null,
                workspaceDir,
              })
            } catch {
              decision = 'deny'
            }
          }
          const approved = decision !== 'deny' && decision !== 'never'
          await appendEvent(job.id, { type: 'tool_permission_resolved', toolId: ap.approvalId, toolName: ap.toolCall?.toolName, decision })
          // Build the continuation directly from the approval request — no need to
          // round-trip through response messages, which don't reliably carry the
          // request back.
          continuations.push({
            approvalResponse: { type: 'tool-approval-response', approvalId: ap.approvalId, approved },
            toolCall: {
              type: 'tool-call',
              toolCallId: ap.toolCall?.toolCallId,
              toolName: ap.toolCall?.toolName,
              input: ap.toolCall?.input,
            },
          })
        }

        result = await agent.continueStream({
          session,
          toolApprovalContinuations: continuations,
          abortSignal: abortController.signal,
        })
      }

      // Turn succeeded: checkpoint the pre-turn state (the live workspace is
      // still untouched here — the agent worked in the worktree), then apply the
      // agent's changes back to the live workspace.
      if (worktree) await commitWorktree(job, worktree, appendEvent, createCheckpoint)

      await appendEvent(job.id, { type: 'done' })
    } catch (err) {
      // Turn failed/aborted: discard the worktree, leaving the live workspace
      // exactly as it was.
      await appendEvent(job.id, { type: 'error', error: errText(err) })
      await appendEvent(job.id, { type: 'done' })
    } finally {
      try { await session?.destroy() } catch {}
      try { removeWorktree(worktree) } catch {}
    }
  }

  return { runHarnessJob }
}

// --- self-test: prove the stream mapping against a REAL run ---------------
// Usage: node bin/harness-runtime.mjs --selftest [claude|codex]
if (process.argv[1] && process.argv[1].endsWith('harness-runtime.mjs') && process.argv.includes('--selftest')) {
  const provider = process.argv.find(a => a === 'claude' || a === 'codex' || a === 'pi') ?? 'claude'
  const mode = process.argv.find(a => a === 'default' || a === 'acceptEdits' || a === 'bypassPermissions') ?? 'acceptEdits'
  const { mkdtempSync, existsSync, readFileSync, writeFileSync } = await import('node:fs')
  const { tmpdir, homedir } = await import('node:os')
  const { execFileSync } = await import('node:child_process')
  const daemonHome = mkdtempSync(join(tmpdir(), 'codesurf-harness-home-'))
  // A GIT workspace, so the run exercises the worktree → checkpoint → apply path.
  const workspace = mkdtempSync(join(tmpdir(), 'codesurf-harness-ws-'))
  const target = join(workspace, 'STATUS.md')
  writeFileSync(target, 'ORIGINAL\n')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace })
  execFileSync('git', ['config', 'user.email', 'selftest@codesurf.local'], { cwd: workspace })
  execFileSync('git', ['config', 'user.name', 'CodeSurf Selftest'], { cwd: workspace })
  execFileSync('git', ['add', '-A'], { cwd: workspace })
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: workspace })
  const realHome = process.env.HOME || homedir()
  const events = []
  const appendEvent = async (_jobId, evt) => {
    events.push(evt)
    if (evt.type === 'text') process.stdout.write(evt.text)
    else if (evt.type === 'thinking') process.stdout.write(`\x1b[2m${evt.text}\x1b[0m`)
    else if (evt.type === 'tool_input') process.stdout.write(`\n[tool_input] ${String(evt.text).slice(0, 300)}\n`)
    else if (evt.type === 'error') process.stdout.write(`\n[error] ${String(evt.error).slice(0, 500)}\n`)
    else process.stdout.write(`\n[${evt.type}${evt.toolName ? ' ' + evt.toolName : ''}]\n`)
  }
  const { runHarnessJob } = createHarnessRunner({ homeDir: daemonHome })
  const job = { id: 'selftest-job' }
  const request = {
    provider,
    mode,
    messages: [{ role: 'user', content: 'There is a file named STATUS.md in your current working directory containing the word ORIGINAL. Replace its entire contents with exactly the single word MODIFIED. Then reply DONE.' }],
  }
  console.log(`\n=== harness self-test: ${provider} mode=${mode}\n  workspace=${workspace}\n  daemonHome=${daemonHome} ===\n`)
  await runHarnessJob(job, request, workspace, '', { appendEvent })
  const types = events.reduce((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {})
  const sawText = (types.text ?? 0) > 0
  const sawDone = (types.done ?? 0) > 0
  const sawError = (types.error ?? 0) > 0
  // Reality check: the in-place edit must land in the workspace file.
  const edited = existsSync(target) && readFileSync(target, 'utf8').includes('MODIFIED')
  const leakedHome = existsSync(join(realHome, 'STATUS.md'))
  // Diagnostic: where did STATUS.md / MODIFIED actually land?
  const { readdirSync, statSync } = await import('node:fs')
  const hits = []
  const scan = (dir, depth = 0) => {
    if (depth > 5) return
    let names; try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (name === 'node_modules' || name === '.git') continue
      const p = join(dir, name); let s; try { s = statSync(p) } catch { continue }
      if (s.isDirectory()) scan(p, depth + 1)
      else if (name === 'STATUS.md') { let c=''; try{c=readFileSync(p,'utf8').trim()}catch{}; hits.push(`${p.replace(workspace,'<ws>').replace(daemonHome,'<home>')} = ${JSON.stringify(c)}`) }
    }
  }
  scan(workspace); scan(daemonHome)
  console.log(`\n=== all STATUS.md files ===\n${hits.length ? hits.map(h => '  ' + h).join('\n') : '  (none)'}`)
  console.log(`\n=== event type counts ===\n${JSON.stringify(types, null, 2)}`)
  console.log(`\nworkspace STATUS.md = ${existsSync(target) ? JSON.stringify(readFileSync(target, 'utf8').trim()) : '(missing)'}`)
  console.log(`edit landed in workspace = ${edited}`)
  console.log(`leaked STATUS.md to real $HOME = ${leakedHome}`)
  const pass = sawText && sawDone && !sawError && edited && !leakedHome
  console.log(`\nOVERALL = ${pass ? 'PASS' : 'FAIL'} (text=${sawText} done=${sawDone} error=${sawError} editLanded=${edited} leaked=${leakedHome})`)
  process.exit(pass ? 0 : 1)
}

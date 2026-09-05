import { ipcMain, WebContents } from 'electron'
import { existsSync, chmodSync } from 'fs'
import { promises as fsP } from 'fs'
import { execFileSync } from 'child_process'
import { createHash } from 'node:crypto'
import { join, resolve } from 'path'
import { bus } from '../event-bus'
import { writeMCPConfigToWorkspace, writeTileMcpConfig, getTileToken, revokeTileToken } from '../mcp-server'
import { CODESURF_HOME, workspaceTileDir, legacyWorkspaceTileDir } from '../paths'
import { getAllNodeTools } from '../../shared/nodeTools'
import { setTerminalNotifier, updateLinks, removeTile as removePeerTile } from '../peer-state'
import { getWorkspacePathById, readSettingsSync } from './workspace'
import {
  isAllowedBinary,
  terminalLaunchChanged,
  expandHome,
  buildSafeSpawnEnv,
  ALLOWED_AGENT_BINS,
  hasManagedLocalProxyEnvironmentEvidence,
  inferManagedLocalProxyProcessState,
  managedLocalProxyProcessState,
  MANAGED_LOCAL_PROXY_MODE_ENV,
  reconcileManagedLocalProxySession,
  resolveManagedLocalProxySpawnEnvironment,
  shouldForwardTmuxEnvironment,
  type ManagedLocalProxyProcessState,
  type ManagedLocalProxySessionState,
} from './terminal-helpers'
import { handlePtyExit } from './terminal-exit.ts'
import { log } from '../utils/logger.ts'
import { handleTyped, ipcSchemas } from './handleTyped.ts'
import { isValidAgentRoomId } from '../agent-room/validation.ts'
import { loadAuthoritativeChatPeers } from '../chat/peer-authority.ts'
import { ensureLocalProxyRunning, getProxyStatus } from './localProxy.ts'

const terminalLog = log.scope('terminal')

function ensureNodePtySpawnHelperExecutable(): void {
  // On Windows, node-pty uses conpty (no spawn-helper needed)
  if (process.platform === 'win32') return

  const candidates = [
    join(__dirname, '../../node_modules/node-pty/build/Release/spawn-helper'),
    join(__dirname, '../../node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'),
    join(__dirname, '../../node_modules/node-pty/prebuilds/darwin-x64/spawn-helper'),
    join(__dirname, '../../node_modules/node-pty/prebuilds/linux-x64/spawn-helper'),
    join(__dirname, '../../node_modules/node-pty/prebuilds/linux-arm64/spawn-helper'),
    join(process.cwd(), 'node_modules/node-pty/build/Release/spawn-helper'),
    join(process.cwd(), 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'),
    join(process.cwd(), 'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper'),
    join(process.cwd(), 'node_modules/node-pty/prebuilds/linux-x64/spawn-helper'),
    join(process.cwd(), 'node_modules/node-pty/prebuilds/linux-arm64/spawn-helper'),
  ]

  let found = false
  for (const helperPath of candidates) {
    try {
      if (!existsSync(helperPath)) continue
      found = true
      chmodSync(helperPath, 0o755)
    } catch {
      // best-effort only
    }
  }
  if (!found) {
    console.warn('node-pty spawn-helper: no candidates found among checked paths')
  }
}

ensureNodePtySpawnHelperExecutable()

// node-pty must be required (not imported) due to native module ESM issues
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pty = require('node-pty')

// --- tmux session persistence ---------------------------------------------------

let _tmuxPath: string | null = null
function getTmuxPath(): string | null {
  if (_tmuxPath !== null) return _tmuxPath || null
  // tmux is not available on Windows
  if (process.platform === 'win32') {
    _tmuxPath = ''
    return null
  }
  // Search common paths directly instead of using shell
  const candidates = [
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
    '/usr/bin/tmux',
    '/bin/tmux',
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      _tmuxPath = p
      return p
    }
  }
  _tmuxPath = ''
  return null
}

// Write a minimal tmux config that hides the status bar and avoids prefix conflicts
const CODESURF_TMUX_CONF = join(CODESURF_HOME, 'tmux.conf')
function ensureTmuxConf(): void {
  try {
    if (existsSync(CODESURF_TMUX_CONF)) return
    const conf = [
      '# codesurf-managed tmux config — do not edit',
      'set -g status off',
      'set -g mouse on',
      'set -g history-limit 50000',
      'set -g default-terminal "xterm-256color"',
    ].join('\n') + '\n'
    require('fs').writeFileSync(CODESURF_TMUX_CONF, conf)
  } catch { /* best effort */ }
}

const TMUX_PREFIX = 'codesurf-'

function tmuxSessionName(workspaceId: string, tileId: string): string {
  const workspaceScope = createHash('sha256')
    .update(workspaceId)
    .digest('hex')
    .slice(0, 12)
  return `${TMUX_PREFIX}${workspaceScope}-${tileId}`
}

function tmuxSessionExists(sessionName: string): boolean {
  const tmux = getTmuxPath()
  if (!tmux) return false
  try {
    execFileSync(tmux, ['has-session', '-t', sessionName], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function tmuxKillSession(sessionName: string): void {
  const tmux = getTmuxPath()
  if (!tmux) return
  try {
    execFileSync(tmux, ['kill-session', '-t', sessionName], { stdio: 'ignore' })
  } catch { /* session may already be gone */ }
}

function tmuxSessionEnvironmentValue(
  sessionName: string,
  key: string,
): string | null {
  const tmux = getTmuxPath()
  if (!tmux) return null
  try {
    const output = execFileSync(
      tmux,
      ['show-environment', '-t', sessionName, key],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const line = output.trim()
    const prefix = `${key}=`
    return line.startsWith(prefix) ? line.slice(prefix.length) : null
  } catch {
    return null
  }
}

function readTmuxManagedLocalProxyState(
  sessionName: string,
): { eligible: boolean; state: ManagedLocalProxyProcessState } {
  const environment = {
    mode: tmuxSessionEnvironmentValue(sessionName, MANAGED_LOCAL_PROXY_MODE_ENV),
    baseUrl: tmuxSessionEnvironmentValue(sessionName, 'ANTHROPIC_BASE_URL'),
    token: tmuxSessionEnvironmentValue(sessionName, 'ANTHROPIC_AUTH_TOKEN'),
  }
  return {
    eligible: hasManagedLocalProxyEnvironmentEvidence(environment),
    state: inferManagedLocalProxyProcessState(environment),
  }
}

/**
 * Peer state updates previously repainted a tmux status bar here. The status
 * bar is now hidden (see `ensureTmuxConf` + attach-time `status off`), so this
 * is a no-op kept only as a hook for a future in-app peer display.
 */
function updateTmuxStatus(_sessionName: string, _tileId: string): void {
  // intentionally blank — status bar is hidden
}

/** Build the tmux new-session command args for a fresh session. */
function tmuxNewSessionArgs(
  sessionName: string,
  cwd: string,
  bin: string,
  args: string[],
  env: Record<string, string>
): string[] {
  const tmuxArgs = [
    '-u',  // Force UTF-8 so Nerd Font / Unicode glyphs are not stripped
    '-f', CODESURF_TMUX_CONF,
    'new-session', '-d',
    '-s', sessionName,
    '-x', '80', '-y', '24',
    '-c', cwd,
  ]
  // Inject env vars via -e (tmux 3.2+)
  for (const [k, v] of Object.entries(env)) {
    if (k === 'PATH' || k === 'HOME' || k === 'SHELL' || k === 'TERM') continue
    if (shouldForwardTmuxEnvironment(k)) {
      tmuxArgs.push('-e', `${k}=${v}`)
    }
  }
  // Ensure UTF-8 locale is set so tmux doesn't strip Unicode (Nerd Font glyphs, etc.)
  const hasLang = Object.keys(env).some(k => k === 'LANG' || k === 'LC_ALL' || k === 'LC_CTYPE')
  if (!hasLang) {
    tmuxArgs.splice(tmuxArgs.indexOf('new-session') + 1, 0, '-e', 'LANG=en_US.UTF-8')
  }
  tmuxArgs.push(bin, ...args)
  return tmuxArgs
}

interface PtyInstance {
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  onData: (cb: (data: string) => void) => void
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void
}

interface TerminalSession {
  workspaceId: string
  pty: PtyInstance
  listeners: Set<WebContents>
  buffer: string
  tmuxSession?: string // tmux session name if backed by tmux
  shell: string // absolute shell binary used to spawn this pty (for cd syntax)
  launchBin?: string
  launchArgs: string[]
  managedLocalProxy: ManagedLocalProxySessionState
}

interface ResolvedTerminalManagedLocalProxy {
  env: Record<string, string>
  state: ManagedLocalProxyProcessState
}

async function resolveTerminalManagedLocalProxy(
  eligible: boolean,
): Promise<ResolvedTerminalManagedLocalProxy> {
  if (!eligible) {
    return {
      env: {},
      state: managedLocalProxyProcessState('disabled'),
    }
  }

  const managedProxy = await resolveManagedLocalProxySpawnEnvironment(
    readSettingsSync(),
    {
      ensureRunning: ensureLocalProxyRunning,
      getStatus: getProxyStatus,
    },
  )
  if (!managedProxy) {
    return {
      env: {},
      state: managedLocalProxyProcessState('disabled'),
    }
  }
  return {
    env: managedProxy.env,
    state: managedLocalProxyProcessState('enabled', managedProxy.token),
  }
}

const terminals = new Map<string, TerminalSession>()
const terminalBuffers = new Map<string, { data: string; timer: ReturnType<typeof setTimeout> | undefined }>()
const senderTerminalTiles = new WeakMap<WebContents, Set<string>>()
const terminalSenderCleanupAttached = new WeakSet<WebContents>()
/** Cap on the bus accumulator; the flush only ever reads the tail. */
/**
 * Per-tile serialization lane for terminal:create.
 *
 * The handler reads `terminals.get(tileId)` and writes it back many awaits
 * later (writeTileMcpConfig, mkdir, readFile, proxy resolution), with no lock in
 * between. TerminalTile is deliberately mounted twice per tileId, and each mount
 * calls startPty(), so two calls could both observe `existing === undefined`,
 * both spawn, and the second `set` would replace the first — leaving a PTY that
 * destroy/detach/killAllChatProcesses can no longer reach and whose onData
 * returns early. Queuing per tile means the second call runs after the first has
 * registered its session and therefore takes the existing-session reuse branch.
 *
 * Shaped like runWatchSubscriptionOperation in ipc/fs.ts.
 */
const terminalCreateLanes = new Map<string, Promise<unknown>>()

function runTerminalCreateLane<T>(tileId: string, operation: () => Promise<T>): Promise<T> {
  const previous = terminalCreateLanes.get(tileId) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  terminalCreateLanes.set(tileId, current)
  void current.catch(() => undefined).finally(() => {
    if (terminalCreateLanes.get(tileId) === current) terminalCreateLanes.delete(tileId)
  })
  return current
}

const TERMINAL_BUS_MAX_BUFFER = 4096

const TERMINAL_BUS_DEBOUNCE = 800 // ms

function trackTerminalSender(sender: WebContents, tileId: string): void {
  const existing = senderTerminalTiles.get(sender)
  if (existing) existing.add(tileId)
  else senderTerminalTiles.set(sender, new Set([tileId]))

  if (terminalSenderCleanupAttached.has(sender)) return
  terminalSenderCleanupAttached.add(sender)
  sender.once('destroyed', () => {
    const tileIds = senderTerminalTiles.get(sender)
    if (tileIds) {
      for (const id of tileIds) {
        terminals.get(id)?.listeners.delete(sender)
      }
    }
    senderTerminalTiles.delete(sender)
    terminalSenderCleanupAttached.delete(sender)
  })
}

function flushTerminalToBus(tileId: string): void {
  const buf = terminalBuffers.get(tileId)
  if (!buf || !buf.data) return
  const data = buf.data
  buf.data = ''
  // Strip ANSI for the bus event
  const clean = data.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim()
  if (!clean) return
  const truncated = clean.length > 200 ? clean.slice(-200) : clean
  const workspaceId = terminals.get(tileId)?.workspaceId
  if (!workspaceId) return
  bus.publish({
    channel: `tile:${workspaceId}:${tileId}`,
    type: 'activity',
    source: `terminal:${tileId}`,
    payload: { workspaceId, output: truncated }
  })
}

export function registerTerminalIPC(): void {
  // Register PTY notifier — updates tmux status bar for peer state
  setTerminalNotifier((workspaceId: string, tileId: string, _line: string) => {
    const session = terminals.get(tileId)
    if (session?.workspaceId !== workspaceId) return
    if (!session?.tmuxSession) return
    updateTmuxStatus(session.tmuxSession, tileId)
  })

  handleTyped('terminal:create', {
    args: [
      ipcSchemas.boundedString(),
      ipcSchemas.boundedString(),
      ipcSchemas.boundedString(),
      ipcSchemas.optionalString,
      ipcSchemas.stringArray.optional(),
    ] as const,
    handler: async (event, tileId, workspaceId, workspaceDir, launchBin, launchArgs) => {
    return runTerminalCreateLane(tileId, async () => {
    if (!isValidAgentRoomId(workspaceId) || !isValidAgentRoomId(tileId)) {
      // Throw, don't resolve: a resolved value is treated as success by the
      // caller (TerminalTile destructures { buffer } and sets ptyReady), which
      // renders a normal xterm surface that silently swallows all input. The
      // caller's existing .catch(showTerminalUnavailable) handles a rejection.
      throw new Error('Invalid terminal workspace or tile ID')
    }
    // Validate workspaceDir against path traversal — the renderer supplies this
    // and it controls where the PTY spawns, where .codesurf dirs are created, and
    // where the MCP bearer token (.mcp.json) is written.
    const { validateFsPath } = await import('./fs.ts')
    try {
      workspaceDir = validateFsPath(workspaceDir)
    } catch (err) {
      console.warn(`[terminal] Blocked workspaceDir outside allowed roots: ${workspaceDir}`, (err as Error).message)
      throw new Error(`Access denied: ${(err as Error).message}`)
    }

    const existing = terminals.get(tileId)
    let carriedListeners: Set<WebContents> | null = null
    let preResolvedManagedLocalProxy: ResolvedTerminalManagedLocalProxy | null = null
    if (existing) {
      if (existing.workspaceId !== workspaceId) {
        throw new Error('Terminal tile ID is already active in another workspace')
      }

      // A chat terminal is a view over a specific provider session. Reusing a
      // tile id is safe only when the requested provider argv is unchanged;
      // otherwise the old PTY would keep running the previous conversation.
      // Omitted launch metadata remains a reconnect request for legacy callers.
      const launchChanged = terminalLaunchChanged(existing, launchBin, launchArgs)

      if (!launchChanged) {
        try {
          const resolved = await resolveTerminalManagedLocalProxy(
            existing.managedLocalProxy.eligible,
          )
          const reconciliation = reconcileManagedLocalProxySession(
            existing.managedLocalProxy,
            resolved.state,
          )
          existing.managedLocalProxy = reconciliation.state
          if (reconciliation.action === 'reuse') {
            existing.listeners.add(event.sender)
            trackTerminalSender(event.sender, tileId)
            return { cols: 80, rows: 24, buffer: existing.buffer }
          }
          preResolvedManagedLocalProxy = resolved
        } catch (error) {
          return {
            error: error instanceof Error
              ? error.message
              : 'Failed to reconcile the managed local proxy',
          }
        }
      }

      // Process environments are immutable. Remove only this proxy-managed
      // Claude session, then let the normal creation path replace it with the
      // desired mode/token. Non-Claude sessions never reach this branch.
      carriedListeners = new Set(existing.listeners)
      carriedListeners.add(event.sender)
      terminals.delete(tileId)
      if (existing.tmuxSession) tmuxKillSession(existing.tmuxSession)
      try { existing.pty.kill() } catch { /* already stopped */ }
      const pending = terminalBuffers.get(tileId)
      if (pending?.timer) clearTimeout(pending.timer)
      terminalBuffers.delete(tileId)
      if (!launchBin) {
        launchBin = existing.shell
        if (launchArgs === undefined && existing.launchBin === launchBin) {
          launchArgs = existing.launchArgs
        }
      }
    }

    // If a binary is specified, validate it against the allowlist (SEC-04)
    if (launchBin && !isAllowedBinary(launchBin)) {
      console.warn(`[terminal] Blocked non-allowlisted binary: ${launchBin} — falling back to default shell`)
      launchBin = undefined
    }

    // If a binary is specified, spawn it directly (no shell wrapper)
    const defaultShell = process.platform === 'win32'
      ? (process.env.COMSPEC || 'cmd.exe')
      : (process.env.SHELL || '/bin/zsh')
    const bin = launchBin || defaultShell
    const launchContractArgs = launchBin ? [...(launchArgs ?? [])] : []
    const args = launchBin ? (launchArgs ?? []).map(expandHome) : []

    // Check if we should inject MCP config for agent CLIs. Derive the set
    // from the spawn allowlist so the two never drift (SEC-04 + M3).
    const launchBase = (bin.split(/[/\\]/).pop() || '').replace(/\.(exe|cmd|bat|ps1)$/i, '')
    const isAgent = ALLOWED_AGENT_BINS.includes(launchBase)
    const isClaude = launchBase === 'claude'
    let desiredManagedLocalProxy = managedLocalProxyProcessState('disabled')
    const spawnEnv: Record<string, string> = buildSafeSpawnEnv({
      CARD_ID: tileId,
      CODESURF_WORKSPACE_ID: workspaceId,
    })

    // Set CODESURF_DIR so agents know where their per-tile .codesurf folder is
    const contexDir = workspaceTileDir(workspaceDir, tileId)
    const legacyContexDir = legacyWorkspaceTileDir(workspaceDir, tileId)
    spawnEnv.CODESURF_DIR = contexDir
    spawnEnv.COLLAB_DIR = contexDir
    // Shell-launched agents inherit only this workspace/tile principal. Never
    // expose the global bearer or use it as a fallback.
    spawnEnv.CODESURF_MCP_TILE_TOKEN = getTileToken(workspaceId, tileId)
    try {
      const tileConfig = await writeTileMcpConfig(workspaceId, tileId)
      if (tileConfig) spawnEnv.CODESURF_MCP_CONFIG = tileConfig
    } catch {
      // MCP remains unavailable for this terminal when scoped setup fails.
    }

    if (isAgent) {
      // Ensure .codesurf dir exists before reading/spawning
      await fsP.mkdir(join(contexDir, 'context'), { recursive: true })

      // Inject objective.md via -p if it exists
      const objectivePath = join(contexDir, 'objective.md')
      let objective = ''
      try {
        objective = await fsP.readFile(objectivePath, 'utf8')
      } catch { /* no objective yet */ }

      // Always inject a preamble so the agent knows about its .codesurf folder
      const preamble = [
        objective.trim() || '# Objective\n\nAwaiting tasks from the codesurf drawer.',
        '',
        '## CodeSurf Directory',
        `Your per-block directory is at: ${contexDir}`,
        `Legacy path (if you see old docs): ${legacyContexDir}`,
        `Check ${contexDir}/objective.md for updated objectives.`,
        `Use the reload_objective MCP tool to fetch the latest version.`,
        '',
        '## Agent Room (canvas wires)',
        'Blocks wired to you on the canvas share an agent room. Room traffic is real-time (bus) and durable (ledger).',
        `Your block ID is $CARD_ID (always set). Per-tile dir: ${contexDir}`,
        `Room inbox file (updated live): ~/.codesurf/workspaces/${workspaceId}/agent-rooms/inboxes/$CARD_ID/ROOM.md`,
        '',
        'Collaboration tools (MCP prefix mcp__codesurf__):',
        '- `room_status` — room id, members, unread count (start here)',
        '- `room_post` — post message/task/handoff/summary into the room',
        '- `room_consume` — drain unread room traffic into your context',
        '- `peer_set_state` — announce status/task/files to the room',
        '- `peer_get_state` — snapshot of room members',
        '- `peer_send_message` — direct message a room member',
        '',
        'Workflow: On start call room_status + peer_set_state(status=working). Use room_consume when you need peer traffic. room_post handoffs when you need another block to act. Do not poll endlessly — room files and MCP stay current.',
        `Reference: ${contexDir}/peers.md and ~/.codesurf/workspaces/${workspaceId}/agent-rooms/inboxes/$CARD_ID/ROOM.md`,
      ].join('\n')
      args.push('-p', preamble)

      // Read skills.json to filter --allowedTools
      let skillFilter: string[] | null = null
      try {
        const skillsRaw = await fsP.readFile(join(contexDir, 'skills.json'), 'utf8')
        const skills = JSON.parse(skillsRaw) as { enabled?: string[]; disabled?: string[] }
        if (skills.disabled && skills.disabled.length > 0) {
          skillFilter = skills.disabled
        }
      } catch { /* no skills config */ }

      // Auto-allow codesurf MCP tools for Claude Code CLI launches
      if (isClaude) {
        // Point Claude Code at the tile-scoped MCP config (not just workspace
        // .mcp.json which still carries the global token for human CLI use).
        if (spawnEnv.CODESURF_MCP_CONFIG) {
          args.push('--mcp-config', spawnEnv.CODESURF_MCP_CONFIG)
        }
        const mcpToolNames = [
          'mcp__codesurf__canvas_create_tile', 'mcp__codesurf__canvas_open_file',
          'mcp__codesurf__canvas_pan_to', 'mcp__codesurf__canvas_list_tiles',
          'mcp__codesurf__card_complete', 'mcp__codesurf__card_update',
          'mcp__codesurf__card_error', 'mcp__codesurf__canvas_event',
          'mcp__codesurf__request_input',
          'mcp__codesurf__kanban_get_board', 'mcp__codesurf__kanban_create_card',
          'mcp__codesurf__kanban_update_card', 'mcp__codesurf__kanban_move_card',
          'mcp__codesurf__kanban_pause_card', 'mcp__codesurf__kanban_delete_card',
          'mcp__codesurf__kanban_create_column', 'mcp__codesurf__kanban_rename_column',
          'mcp__codesurf__kanban_delete_column',
          'mcp__codesurf__update_progress',
          'mcp__codesurf__log_activity', 'mcp__codesurf__create_task',
          'mcp__codesurf__update_task', 'mcp__codesurf__notify',
          'mcp__codesurf__ask',
          // Collab tools
          'mcp__codesurf__reload_objective', 'mcp__codesurf__pause_task',
          'mcp__codesurf__get_context',
          // Agent room + peer tools
          'mcp__codesurf__room_status', 'mcp__codesurf__room_post', 'mcp__codesurf__room_consume',
          'mcp__codesurf__peer_set_state', 'mcp__codesurf__peer_get_state',
          'mcp__codesurf__peer_send_message', 'mcp__codesurf__peer_read_messages',
          'mcp__codesurf__peer_add_todo', 'mcp__codesurf__peer_complete_todo',
          // Node bridge tools — peer-to-peer interaction with linked tiles
          ...getAllNodeTools().map(t => `mcp__codesurf__${t.name}`),
        ]
        // Filter out disabled skills from allowed tools
        const filteredTools = skillFilter
          ? mcpToolNames.filter(t => !skillFilter!.some(d => t.includes(d)))
          : mcpToolNames
        args.push('--allowedTools', filteredTools.join(','))
      }

      // Redirect Claude API calls only after the managed listener is live and
      // inject its runtime bearer explicitly. Inherited provider credentials
      // remain stripped by buildSafeSpawnEnv.
      if (isClaude) {
        try {
          const managedProxy = preResolvedManagedLocalProxy
            ?? await resolveTerminalManagedLocalProxy(true)
          Object.assign(spawnEnv, managedProxy.env)
          desiredManagedLocalProxy = managedProxy.state
          spawnEnv[MANAGED_LOCAL_PROXY_MODE_ENV] = managedProxy.state.mode
        } catch (error) {
          return {
            error: error instanceof Error
              ? error.message
              : 'Failed to prepare the managed local proxy',
          }
        }
      }

      bus.publish({
        channel: `tile:${workspaceId}:${tileId}`,
        type: 'system',
        source: `terminal:${tileId}`,
        payload: { action: 'agent_launched', workspaceId, agent: launchBin }
      })
    }

    // Remove legacy workspace-global CodeSurf credentials; scoped config is
    // supplied explicitly through CODESURF_MCP_CONFIG.
    writeMCPConfigToWorkspace(workspaceDir).catch(() => {})

    // --- tmux persistence: reattach or create a new tmux session ---------------
    const tmux = getTmuxPath()
    const sessName = tmuxSessionName(workspaceId, tileId)
    let useTmux = false
    let reattaching = false
    let managedLocalProxyEligible = isClaude
    let actualManagedLocalProxy = desiredManagedLocalProxy

    if (tmux) {
      ensureTmuxConf()
      reattaching = tmuxSessionExists(sessName)
      if (reattaching) {
        const actual = readTmuxManagedLocalProxyState(sessName)
        managedLocalProxyEligible = isClaude && actual.eligible
        const reconciliation = reconcileManagedLocalProxySession(
          {
            eligible: managedLocalProxyEligible,
            desired: desiredManagedLocalProxy,
            actual: actual.state,
          },
          desiredManagedLocalProxy,
        )
        if (reconciliation.action === 'replace') {
          // A tmux-hosted Claude process cannot have its environment replaced
          // in place. Rotate it on mode or bearer changes. The eligibility
          // guard deliberately preserves unrelated non-Claude sessions.
          tmuxKillSession(sessName)
          reattaching = false
          managedLocalProxyEligible = isClaude
          actualManagedLocalProxy = desiredManagedLocalProxy
        } else {
          actualManagedLocalProxy = reconciliation.state.actual
        }
      }
      if (!reattaching) {
        // Create a detached tmux session running the target binary
        try {
          const newArgs = tmuxNewSessionArgs(sessName, workspaceDir, bin, args, spawnEnv)
          execFileSync(tmux, newArgs, { stdio: 'ignore', env: spawnEnv })
          useTmux = true
        } catch (err) {
          console.warn(`[terminal] tmux new-session failed, falling back to direct PTY:`, err)
        }
      } else {
        useTmux = true
        terminalLog.info(`Reattaching to existing tmux session: ${sessName}`)
      }
    }

    // Force status bar off on both new and reattached sessions — belt &
    // braces alongside `set -g status off` in the conf file, which can be
    // ignored if a pre-existing session was created before the conf landed.
    if (useTmux && tmux) {
      try {
        execFileSync(tmux, ['set-option', '-t', sessName, 'status', 'off'], { stdio: 'ignore' })
      } catch { /* best effort */ }
    }

    let term: PtyInstance
    if (useTmux && tmux) {
      // Attach to the tmux session via node-pty
      term = pty.spawn(tmux, ['-u', '-f', CODESURF_TMUX_CONF, 'attach-session', '-t', sessName], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: workspaceDir,
        env: spawnEnv,
      })
    } else {
      // Fallback: direct PTY spawn (no tmux available)
      term = pty.spawn(bin, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: workspaceDir,
        env: spawnEnv,
      })
    }

    const session: TerminalSession = {
      workspaceId,
      pty: term,
      listeners: carriedListeners ?? new Set([event.sender]),
      buffer: '',
      tmuxSession: useTmux ? sessName : undefined,
      shell: bin,
      launchBin,
      launchArgs: launchContractArgs,
      managedLocalProxy: {
        eligible: managedLocalProxyEligible,
        desired: desiredManagedLocalProxy,
        actual: actualManagedLocalProxy,
      },
    }
    terminals.set(tileId, session)
    trackTerminalSender(event.sender, tileId)

    bus.publish({
      channel: `tile:${workspaceId}:${tileId}`,
      type: 'system',
      source: `terminal:${tileId}`,
      payload: {
        action: reattaching ? 'reattached' : 'created',
        workspaceId,
        workspaceDir,
        tmux: useTmux,
      }
    })

    term.onData((data: string) => {
      if (terminals.get(tileId) !== session || session.pty !== term) return
      session.buffer = (session.buffer + data).slice(-200000)
      for (const listener of [...session.listeners]) {
        try {
          if (!listener.isDestroyed()) {
            listener.send(`terminal:data:${tileId}`, data)
            listener.send(`terminal:active:${tileId}`)
          } else {
            session.listeners.delete(listener)
          }
        } catch {
          session.listeners.delete(listener)
        }
      }

      // Accumulate and debounce terminal output to bus
      let buf = terminalBuffers.get(tileId)
      if (!buf) {
        buf = { data: '', timer: undefined }
        terminalBuffers.set(tileId, buf)
      }
      // Bounded like session.buffer above. This is a reset-on-every-chunk
      // debounce with no maximum wait, so a PTY emitting at least one chunk per
      // TERMINAL_BUS_DEBOUNCE (yes, tail -f, a verbose build) never flushed and
      // the accumulator grew at PTY throughput until `buf.data + data` threw
      // RangeError: Invalid string length inside this unguarded onData listener
      // — fatal for the main process. flushTerminalToBus keeps only the last
      // 200 chars anyway, so nothing beyond the cap was ever used.
      buf.data = (buf.data + data).slice(-TERMINAL_BUS_MAX_BUFFER)
      if (buf.timer) clearTimeout(buf.timer)
      buf.timer = setTimeout(() => flushTerminalToBus(tileId), TERMINAL_BUS_DEBOUNCE)
    })

    term.onExit(({ exitCode }) => {
      handlePtyExit(tileId, exitCode, term, {
        terminals,
        terminalBuffers,
        publish: (event) => bus.publish(event),
        // Drop the tmux session with the shell so Enter respawns fresh instead
        // of reattaching a dead session (M5).
        killTmuxSession: tmuxKillSession,
      })
    })

    return { cols: 80, rows: 24, buffer: '' }
    })
    },
  })

  handleTyped('terminal:write', {
    args: [ipcSchemas.boundedString(), ipcSchemas.terminalData] as const,
    handler: (_evt, tileId, data) => {
      terminals.get(tileId)?.pty.write(data)
    },
  })

  // terminal:cd — change the working directory of a terminal
  // Clears the current input line first to avoid corrupting in-progress input.
  //
  // Security note: `dirPath` is NOT workspace-scoped by design. The terminal is
  // a user-owned shell; cd-ing anywhere the user could cd from a real shell is
  // expected behaviour. The per-shell escaping below (single-quote doubling for
  // POSIX, double-quote doubling for cmd, LiteralPath for PowerShell) prevents
  // argument injection, which is the only injection vector that matters here.
  handleTyped('terminal:cd', {
    args: [ipcSchemas.boundedString(), ipcSchemas.boundedString()] as const,
    handler: (_evt, tileId, dirPath) => {
    const session = terminals.get(tileId)
    if (!session) return
    // A CR in the path is an Enter keypress to the line editor, and a following
    // \x03 aborts the PS2 continuation back to a fresh prompt — so trailing text
    // in a directory name runs as its own command. Quoting cannot prevent this;
    // the bytes must not reach the PTY at all. Renderer-reachable: the File
    // Explorer passes filesystem entry paths straight in, and POSIX filenames
    // may legally contain \r and \x03. Reject rather than strip, so a hostile
    // name is visible instead of silently becoming a different directory.
    if (/[\x00-\x1f\x7f]/.test(dirPath)) {
      throw new Error('Refusing to cd: path contains control characters')
    }
    const shellBase = (session.shell.split(/[/\\]/).pop() || '').toLowerCase()
    // \x15 = Ctrl-U (clear current input line), then the platform-appropriate
    // cd syntax, then \r (enter)
    let cdLine: string
    if (shellBase === 'cmd.exe') {
      // cmd needs `/d` to switch drives (e.g. C:\ → G:\) and double-quoting
      cdLine = `cd /d "${dirPath.replace(/"/g, '""')}"`
    } else if (shellBase === 'powershell.exe' || shellBase === 'pwsh.exe') {
      // -LiteralPath avoids wildcard interpretation; single quotes are safe
      // when we escape embedded single quotes by doubling them
      cdLine = `Set-Location -LiteralPath '${dirPath.replace(/'/g, "''")}'`
    } else {
      // POSIX shells: bash/zsh/fish all accept `cd "PATH"`. Escape single
      // quotes the bash way since we wrap in single quotes below.
      cdLine = `cd '${dirPath.replace(/'/g, "'\\''")}'`
    }
    session.pty.write(`\x15${cdLine}\r`)
    },
  })

  ipcMain.handle('terminal:resize', (_, tileId: string, cols: number, rows: number) => {
    if (cols > 0 && rows > 0) {
      terminals.get(tileId)?.pty.resize(Math.floor(cols), Math.floor(rows))
    }
  })

  // terminal:destroy — kills the PTY attachment AND the tmux session (tile deleted)
  ipcMain.handle('terminal:destroy', (_, tileId: string, workspaceId: string) => {
    const session = terminals.get(tileId)
    const sessionWorkspaceId = session?.workspaceId ?? workspaceId
    if (session && session.workspaceId !== workspaceId) return
    if (session) {
      // Kill the tmux session if this terminal was tmux-backed
      if (session.tmuxSession) {
        tmuxKillSession(session.tmuxSession)
      }
      try { session.pty.kill() } catch { /* ignore */ }
      terminals.delete(tileId)
    }
    bus.publish({
      channel: `tile:${sessionWorkspaceId}:${tileId}`,
      type: 'system',
      source: `terminal:${tileId}`,
      payload: { action: 'destroyed', workspaceId: sessionWorkspaceId }
    })
    // Clean up buffer and peer state
    const buf = terminalBuffers.get(tileId)
    if (buf?.timer) clearTimeout(buf.timer)
    terminalBuffers.delete(tileId)
    removePeerTile(sessionWorkspaceId, tileId)
    
    // Revoke the tile's MCP token since the tile is being destroyed
    revokeTileToken(sessionWorkspaceId, tileId)
  })

  // terminal:detach — disconnects the PTY attachment but leaves tmux session alive
  // Used on window reload / app quit so sessions survive restarts
  ipcMain.handle('terminal:detach', (_, tileId: string) => {
    const session = terminals.get(tileId)
    if (session) {
      try { session.pty.kill() } catch { /* ignore */ }
      terminals.delete(tileId)
    }
    const buf = terminalBuffers.get(tileId)
    if (buf?.timer) clearTimeout(buf.timer)
    terminalBuffers.delete(tileId)
  })

  // terminal:update-peers — sync agent room membership + write peers.md / room status
  ipcMain.handle('terminal:update-peers', async (
    _,
    tileId: string,
    workspaceId: string,
    workspaceDir: string,
    peers: Array<{ peerId: string; peerType: string; tools: string[] }>,
  ) => {
    if (!isValidAgentRoomId(workspaceId) || !isValidAgentRoomId(tileId)) {
      throw new Error('Invalid terminal peer scope')
    }
    const registeredWorkspaceDir = await getWorkspacePathById(workspaceId)
    if (!registeredWorkspaceDir) throw new Error(`Workspace not found: ${workspaceId}`)
    const canonicalWorkspaceDir = await fsP.realpath(registeredWorkspaceDir)
    if (String(workspaceDir ?? '').trim()) {
      let suppliedWorkspaceDir: string
      try {
        suppliedWorkspaceDir = await fsP.realpath(resolve(workspaceDir))
      } catch {
        throw new Error('workspaceDir does not match the registered workspace root')
      }
      if (suppliedWorkspaceDir !== canonicalWorkspaceDir) {
        throw new Error('workspaceDir does not match the registered workspace root')
      }
    }
    const authority = await loadAuthoritativeChatPeers(workspaceId, tileId, peers)
    const authoritativePeers = authority.peers
    const tileTypes: Record<string, string> = { [tileId]: 'terminal' }
    for (const peer of authoritativePeers) tileTypes[peer.peerId] = peer.peerType || 'unknown'
    const room = updateLinks(
      workspaceId,
      tileId,
      authoritativePeers.map(peer => peer.peerId),
      tileTypes,
    )

    // Also update this tile's own tmux status bar
    const session = terminals.get(tileId)
    if (session?.tmuxSession) {
      updateTmuxStatus(session.tmuxSession, tileId)
    }

    const contexDir = workspaceTileDir(canonicalWorkspaceDir, tileId)
    const peersPath = join(contexDir, 'peers.md')

    if (authoritativePeers.length === 0) {
      try { await fsP.unlink(peersPath) } catch { /* didn't exist or not permitted */ }
      bus.publish({
        channel: `tile:${workspaceId}:${tileId}`,
        type: 'system',
        source: `terminal:${tileId}`,
        payload: { action: 'peers_updated', workspaceId, count: 0, roomId: null }
      })
      return
    }

    const lines = [
      '# Agent Room',
      '',
      room ? `Room id: \`${room.id}\`` : 'Room: (pending)',
      '',
      'These blocks share an agent room with you. Prefer MCP `room_status` / `room_post` / `room_consume`.',
      `Live inbox: ~/.codesurf/workspaces/${workspaceId}/agent-rooms/inboxes/${tileId}/ROOM.md`,
      '',
    ]
    for (const peer of authoritativePeers) {
      lines.push(`## ${peer.peerType} — \`${peer.peerId}\``)
      if (peer.tools.length > 0) {
        lines.push('Available tools:')
        for (const tool of peer.tools) {
          lines.push(`- \`mcp__codesurf__${tool}\` (pass \`tile_id: "${peer.peerId}"\`)`)
        }
      }
      lines.push('')
    }
    lines.push('---')
    lines.push('*This file is auto-updated when canvas links change. Use `reload_objective` or re-read this file for the latest state.*')

    let persisted = true
    try {
      await fsP.mkdir(contexDir, { recursive: true })
      await fsP.writeFile(peersPath, lines.join('\n'), 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES') throw error
      persisted = false
    }

    bus.publish({
      channel: `tile:${workspaceId}:${tileId}`,
      type: 'system',
      source: `terminal:${tileId}`,
      payload: {
        action: 'peers_updated',
        workspaceId,
        count: authoritativePeers.length,
        peerIds: authoritativePeers.map(peer => peer.peerId),
        persisted,
      }
    })
  })
}

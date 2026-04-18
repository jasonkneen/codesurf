import { ipcMain, WebContents } from 'electron'
import { existsSync, chmodSync } from 'fs'
import { promises as fsP } from 'fs'
import { execFileSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { bus } from '../event-bus'
import { writeMCPConfigToWorkspace } from '../mcp-server'
import { CONTEX_HOME, workspaceTileDir, legacyWorkspaceTileDir } from '../paths'
import { getAllNodeTools } from '../../shared/nodeTools'
import { setTerminalNotifier, updateLinks, removeTile as removePeerTile, getLinkedPeerStates, getUnreadMessages } from '../peer-state'
import { readSettingsSync } from './workspace'

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

// --- Security: binary allowlist for pty spawn (SEC-04) ---
const ALLOWED_SHELLS = new Set([
  '/bin/bash', '/bin/zsh', '/bin/sh', '/usr/bin/bash', '/usr/bin/zsh',
  '/usr/local/bin/bash', '/usr/local/bin/zsh', '/usr/local/bin/fish',
  '/opt/homebrew/bin/bash', '/opt/homebrew/bin/zsh', '/opt/homebrew/bin/fish',
])

// Windows shells
if (process.platform === 'win32') {
  ALLOWED_SHELLS.add('powershell.exe')
  ALLOWED_SHELLS.add('pwsh.exe')
  ALLOWED_SHELLS.add('cmd.exe')
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  ALLOWED_SHELLS.add(`${sysRoot}\\System32\\cmd.exe`)
  ALLOWED_SHELLS.add(`${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`)
  // Add pwsh if installed
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  ALLOWED_SHELLS.add(`${programFiles}\\PowerShell\\7\\pwsh.exe`)
}

// Also allow the user's default shell
const userShell = process.env.SHELL || (process.platform === 'win32' ? process.env.COMSPEC : undefined)
if (userShell) ALLOWED_SHELLS.add(userShell)

// Known agent CLIs that are allowed to be spawned directly
const ALLOWED_AGENT_BINS = ['claude', 'codex', 'aider', 'opencode', 'openclaw', 'hermes']

function isAllowedBinary(bin: string): boolean {
  // Allow known shells
  if (ALLOWED_SHELLS.has(bin)) return true
  // Allow known agent CLIs (matched by basename, handle both / and \ separators,
  // strip any Windows shim extension so .exe / .cmd / .bat / .ps1 all match)
  const base = (bin.split(/[/\\]/).pop() || '').replace(/\.(exe|cmd|bat|ps1)$/i, '')
  if (ALLOWED_AGENT_BINS.includes(base)) return true
  return false
}

// node-pty must be required (not imported) due to native module ESM issues
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pty = require('node-pty')

function expandHome(arg: string): string {
  if (!arg.startsWith('~')) return arg
  const home = homedir()
  if (arg === '~') return home

  // Resolve legacy ~/.contex/ and current ~/.codesurf/ paths to CONTEX_HOME
  if (arg.startsWith('~/.contex/')) {
    return join(CONTEX_HOME, arg.slice('~/.contex/'.length))
  }
  if (arg.startsWith('~\\.contex\\')) {
    return join(CONTEX_HOME, arg.slice('~\\.contex\\'.length))
  }
  if (arg.startsWith('~/.codesurf/')) {
    return join(CONTEX_HOME, arg.slice('~/.codesurf/'.length))
  }

  if (arg.startsWith('~/') || arg.startsWith('~\\')) return join(home, arg.slice(2))
  return arg
}

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
const CONTEX_TMUX_CONF = join(CONTEX_HOME, 'tmux.conf')
function ensureTmuxConf(): void {
  try {
    if (existsSync(CONTEX_TMUX_CONF)) return
    const conf = [
      '# contex-managed tmux config — do not edit',
      'set -g status off',
      'set -g mouse on',
      'set -g history-limit 50000',
      'set -g default-terminal "xterm-256color"',
    ].join('\n') + '\n'
    require('fs').writeFileSync(CONTEX_TMUX_CONF, conf)
  } catch { /* best effort */ }
}

const TMUX_PREFIX = 'contex-'

function tmuxSessionName(tileId: string): string {
  return `${TMUX_PREFIX}${tileId}`
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

/** Update tmux status bar with current peer link state */
function updateTmuxStatus(sessionName: string, tileId: string): void {
  const tmux = getTmuxPath()
  if (!tmux) return

  const peers = getLinkedPeerStates(tileId)
  const unread = getUnreadMessages(tileId)

  let statusRight = ''
  if (peers.length === 0 && unread.length === 0) {
    statusRight = '#[fg=#555]no peers'
  } else {
    const parts: string[] = []
    for (const p of peers) {
      const shortId = p.tileId.slice(-6)
      const statusIcon = p.status === 'working' ? '#[fg=#f0a050]●' :
                         p.status === 'blocked' ? '#[fg=#f05050]●' :
                         p.status === 'done'    ? '#[fg=#50c878]●' :
                                                  '#[fg=#555]●'
      const task = p.task ? ` ${p.task.slice(0, 20)}` : ''
      parts.push(`${statusIcon} #[fg=#7bf1ff]${shortId}#[fg=#aaa]${task}`)
    }
    if (unread.length > 0) {
      parts.push(`#[fg=#f0a050]✉ ${unread.length}`)
    }
    statusRight = parts.join(' #[fg=#555]│ ')
  }

  try {
    execFileSync(tmux, ['set-option', '-t', sessionName, 'status', 'on'], { stdio: 'ignore' })
    execFileSync(tmux, ['set-option', '-t', sessionName, 'status-style', 'bg=#1e1e1e,fg=#aaa'], { stdio: 'ignore' })
    execFileSync(tmux, ['set-option', '-t', sessionName, 'status-left', '#[fg=#7bf1ff,bold] contex #[fg=#555]│ '], { stdio: 'ignore' })
    execFileSync(tmux, ['set-option', '-t', sessionName, 'status-left-length', '20'], { stdio: 'ignore' })
    execFileSync(tmux, ['set-option', '-t', sessionName, 'status-right', statusRight], { stdio: 'ignore' })
    execFileSync(tmux, ['set-option', '-t', sessionName, 'status-right-length', '80'], { stdio: 'ignore' })
  } catch { /* tmux session may be gone */ }
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
    '-f', CONTEX_TMUX_CONF,
    'new-session', '-d',
    '-s', sessionName,
    '-x', '80', '-y', '24',
    '-c', cwd,
  ]
  // Inject env vars via -e (tmux 3.2+)
  for (const [k, v] of Object.entries(env)) {
    if (k === 'PATH' || k === 'HOME' || k === 'SHELL' || k === 'TERM') continue
    if (k.startsWith('CONTEX_') || k.startsWith('COLLAB_') || k === 'CARD_ID'
      || k === 'LANG' || k === 'LC_ALL' || k === 'LC_CTYPE') {
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
}

interface TerminalSession {
  pty: PtyInstance
  listeners: Set<WebContents>
  buffer: string
  tmuxSession?: string // tmux session name if backed by tmux
  shell: string // absolute shell binary used to spawn this pty (for cd syntax)
}

const terminals = new Map<string, TerminalSession>()
const terminalBuffers = new Map<string, { data: string; timer: ReturnType<typeof setTimeout> | undefined }>()
const senderTerminalTiles = new WeakMap<WebContents, Set<string>>()
const terminalSenderCleanupAttached = new WeakSet<WebContents>()
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
  bus.publish({
    channel: `tile:${tileId}`,
    type: 'activity',
    source: `terminal:${tileId}`,
    payload: { output: truncated }
  })
}

export function registerTerminalIPC(): void {
  // Register PTY notifier — updates tmux status bar for peer state
  setTerminalNotifier((tileId: string, line: string) => {
    const session = terminals.get(tileId)
    if (!session?.tmuxSession) return
    updateTmuxStatus(session.tmuxSession, tileId)
  })

  ipcMain.handle('terminal:create', async (event, tileId: string, workspaceDir: string, launchBin?: string, launchArgs?: string[]) => {
    const existing = terminals.get(tileId)
    if (existing) {
      existing.listeners.add(event.sender)
      trackTerminalSender(event.sender, tileId)
      return { cols: 80, rows: 24, buffer: existing.buffer }
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
    const args = launchBin ? (launchArgs ?? []).map(expandHome) : []

    // Check if we should inject MCP config for agent CLIs
    const agentBins = ['claude', 'codex', 'aider', 'opencode']
    const isAgent = launchBin && agentBins.some(a => launchBin.includes(a))
    const spawnEnv: Record<string, string> = { ...process.env as Record<string, string>, CARD_ID: tileId }

    // Set CONTEX_DIR so agents know where their per-tile .contex folder is
    const contexDir = workspaceTileDir(workspaceDir, tileId)
    const legacyContexDir = legacyWorkspaceTileDir(workspaceDir, tileId)
    spawnEnv.CONTEX_DIR = contexDir
    spawnEnv.COLLAB_DIR = contexDir

    if (isAgent) {
      const mcpConfigPath = join(CONTEX_HOME, 'mcp-server.json')
      spawnEnv.CONTEX_MCP_CONFIG = mcpConfigPath

      // Ensure .contex dir exists before reading/spawning
      await fsP.mkdir(join(contexDir, 'context'), { recursive: true })

      // Inject objective.md via -p if it exists
      const objectivePath = join(contexDir, 'objective.md')
      let objective = ''
      try {
        objective = await fsP.readFile(objectivePath, 'utf8')
      } catch { /* no objective yet */ }

      // Always inject a preamble so the agent knows about its .contex folder
      const preamble = [
        objective.trim() || '# Objective\n\nAwaiting tasks from the contex drawer.',
        '',
        '## Contex Directory',
        `Your per-block directory is at: ${contexDir}`,
        `Legacy path (if you see old docs): ${legacyContexDir}`,
        `Check ${contexDir}/objective.md for updated objectives.`,
        `Use the reload_objective MCP tool to fetch the latest version.`,
        '',
        '## Peer Collaboration',
        'You are part of a linked block group on an infinite canvas. When other blocks are linked to you, you will see [contex] notifications in your terminal.',
        '',
        'Collaboration tools (call via MCP):',
        '- `peer_set_state` — declare your status, current task, and files (DO THIS FIRST when starting work)',
        '- `peer_get_state` — see what linked peers are working on, their todos, and files',
        '- `peer_send_message` — send a direct message to a linked peer',
        '- `peer_read_messages` — read messages from peers',
        '- `peer_add_todo` — add a todo visible to peers',
        '- `peer_complete_todo` — mark a todo done (peers get notified)',
        '',
        'Workflow: When you start a task, call peer_set_state first. Before editing files, call peer_get_state to check if a peer is already working on them. Coordinate via peer_send_message to avoid conflicts.',
        `Your block ID is available as $CARD_ID. Reference file: ${contexDir}/peers.md`,
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

      // Auto-allow contex MCP tools for Claude Code CLI launches
      const isClaude = launchBin.includes('claude')
      if (isClaude) {
        const mcpToolNames = [
          'mcp__contex__canvas_create_tile', 'mcp__contex__canvas_open_file',
          'mcp__contex__canvas_pan_to', 'mcp__contex__canvas_list_tiles',
          'mcp__contex__card_complete', 'mcp__contex__card_update',
          'mcp__contex__card_error', 'mcp__contex__canvas_event',
          'mcp__contex__request_input',
          'mcp__contex__kanban_get_board', 'mcp__contex__kanban_create_card',
          'mcp__contex__kanban_update_card', 'mcp__contex__kanban_move_card',
          'mcp__contex__kanban_pause_card', 'mcp__contex__kanban_delete_card',
          'mcp__contex__kanban_create_column', 'mcp__contex__kanban_rename_column',
          'mcp__contex__kanban_delete_column',
          'mcp__contex__update_progress',
          'mcp__contex__log_activity', 'mcp__contex__create_task',
          'mcp__contex__update_task', 'mcp__contex__notify',
          'mcp__contex__ask',
          // Collab tools
          'mcp__contex__reload_objective', 'mcp__contex__pause_task',
          'mcp__contex__get_context',
          // Peer collaboration tools
          'mcp__contex__peer_set_state', 'mcp__contex__peer_get_state',
          'mcp__contex__peer_send_message', 'mcp__contex__peer_read_messages',
          'mcp__contex__peer_add_todo', 'mcp__contex__peer_complete_todo',
          // Node bridge tools — peer-to-peer interaction with linked tiles
          ...getAllNodeTools().map(t => `mcp__contex__${t.name}`),
        ]
        // Filter out disabled skills from allowed tools
        const filteredTools = skillFilter
          ? mcpToolNames.filter(t => !skillFilter!.some(d => t.includes(d)))
          : mcpToolNames
        args.push('--allowedTools', filteredTools.join(','))
      }

      // Redirect API calls to local proxy if enabled (e.g. Ollama/llama.cpp via api-proxy)
      const proxySettings = readSettingsSync()
      if (proxySettings.localProxyEnabled && proxySettings.localProxyPort) {
        spawnEnv.ANTHROPIC_BASE_URL = `http://localhost:${proxySettings.localProxyPort}/v1`
      }

      bus.publish({
        channel: `tile:${tileId}`,
        type: 'system',
        source: `terminal:${tileId}`,
        payload: { action: 'agent_launched', agent: launchBin }
      })
    }

    // Ensure .mcp.json exists in workspace so Claude Code auto-discovers contex tools
    writeMCPConfigToWorkspace(workspaceDir).catch(() => {})

    // --- tmux persistence: reattach or create a new tmux session ---------------
    const tmux = getTmuxPath()
    const sessName = tmuxSessionName(tileId)
    let useTmux = false
    let reattaching = false

    if (tmux) {
      ensureTmuxConf()
      reattaching = tmuxSessionExists(sessName)
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
        console.log(`[terminal] Reattaching to existing tmux session: ${sessName}`)
      }
    }

    // Apply contex status bar style to new/reattached tmux sessions
    if (useTmux && tmux) {
      try {
        execFileSync(tmux, ['set-option', '-t', sessName, 'status', 'on'], { stdio: 'ignore' })
        execFileSync(tmux, ['set-option', '-t', sessName, 'status-style', 'bg=#1e1e1e,fg=#aaa'], { stdio: 'ignore' })
        execFileSync(tmux, ['set-option', '-t', sessName, 'status-left', '#[fg=#7bf1ff,bold] contex #[fg=#555]│ '], { stdio: 'ignore' })
        execFileSync(tmux, ['set-option', '-t', sessName, 'status-left-length', '20'], { stdio: 'ignore' })
        execFileSync(tmux, ['set-option', '-t', sessName, 'status-right', '#[fg=#555]no peers'], { stdio: 'ignore' })
        execFileSync(tmux, ['set-option', '-t', sessName, 'status-right-length', '80'], { stdio: 'ignore' })
      } catch { /* best effort */ }
    }

    let term: PtyInstance
    if (useTmux && tmux) {
      // Attach to the tmux session via node-pty
      term = pty.spawn(tmux, ['-u', '-f', CONTEX_TMUX_CONF, 'attach-session', '-t', sessName], {
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
      pty: term,
      listeners: new Set([event.sender]),
      buffer: '',
      tmuxSession: useTmux ? sessName : undefined,
      shell: bin,
    }
    terminals.set(tileId, session)
    trackTerminalSender(event.sender, tileId)

    bus.publish({
      channel: `tile:${tileId}`,
      type: 'system',
      source: `terminal:${tileId}`,
      payload: { action: reattaching ? 'reattached' : 'created', workspaceDir, tmux: useTmux }
    })

    term.onData((data: string) => {
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
      buf.data += data
      if (buf.timer) clearTimeout(buf.timer)
      buf.timer = setTimeout(() => flushTerminalToBus(tileId), TERMINAL_BUS_DEBOUNCE)
    })

    return { cols: 80, rows: 24, buffer: '' }
  })

  ipcMain.handle('terminal:write', (_, tileId: string, data: string) => {
    terminals.get(tileId)?.pty.write(data)
  })

  // terminal:cd — change the working directory of a terminal
  // Clears the current input line first to avoid corrupting in-progress input
  ipcMain.handle('terminal:cd', (_, tileId: string, dirPath: string) => {
    const session = terminals.get(tileId)
    if (!session) return
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
  })

  ipcMain.handle('terminal:resize', (_, tileId: string, cols: number, rows: number) => {
    if (cols > 0 && rows > 0) {
      terminals.get(tileId)?.pty.resize(Math.floor(cols), Math.floor(rows))
    }
  })

  // terminal:destroy — kills the PTY attachment AND the tmux session (tile deleted)
  ipcMain.handle('terminal:destroy', (_, tileId: string) => {
    const session = terminals.get(tileId)
    if (session) {
      // Kill the tmux session if this terminal was tmux-backed
      if (session.tmuxSession) {
        tmuxKillSession(session.tmuxSession)
      }
      try { session.pty.kill() } catch { /* ignore */ }
      terminals.delete(tileId)
    }
    bus.publish({
      channel: `tile:${tileId}`,
      type: 'system',
      source: `terminal:${tileId}`,
      payload: { action: 'destroyed' }
    })
    // Clean up buffer and peer state
    const buf = terminalBuffers.get(tileId)
    if (buf?.timer) clearTimeout(buf.timer)
    terminalBuffers.delete(tileId)
    removePeerTile(tileId)
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

  // terminal:update-peers — updates peer-state links and writes peers.md to context dir
  ipcMain.handle('terminal:update-peers', async (_, tileId: string, workspaceDir: string, peers: Array<{ peerId: string; peerType: string; tools: string[] }>) => {
    // Update the in-memory peer link registry (triggers notifications to peers)
    updateLinks(tileId, (peers ?? []).map(p => p.peerId))

    // Also update this tile's own tmux status bar
    const session = terminals.get(tileId)
    if (session?.tmuxSession) {
      updateTmuxStatus(session.tmuxSession, tileId)
    }

    const contexDir = workspaceTileDir(workspaceDir, tileId)
    await fsP.mkdir(contexDir, { recursive: true })
    const peersPath = join(contexDir, 'peers.md')

    if (!peers || peers.length === 0) {
      try { await fsP.unlink(peersPath) } catch { /* didn't exist */ }
      bus.publish({
        channel: `tile:${tileId}`,
        type: 'system',
        source: `terminal:${tileId}`,
        payload: { action: 'peers_updated', count: 0 }
      })
      return
    }

    const lines = [
      '# Connected Peers',
      '',
      'These blocks are linked to you on the canvas. Use MCP peer bridge tools to interact with them.',
      '',
    ]
    for (const peer of peers) {
      lines.push(`## ${peer.peerType} — \`${peer.peerId}\``)
      if (peer.tools.length > 0) {
        lines.push('Available tools:')
        for (const tool of peer.tools) {
          lines.push(`- \`mcp__contex__${tool}\` (pass \`tile_id: "${peer.peerId}"\`)`)
        }
      }
      lines.push('')
    }
    lines.push('---')
    lines.push('*This file is auto-updated when canvas links change. Use `reload_objective` or re-read this file for the latest state.*')

    await fsP.writeFile(peersPath, lines.join('\n'), 'utf8')
    bus.publish({
      channel: `tile:${tileId}`,
      type: 'system',
      source: `terminal:${tileId}`,
      payload: { action: 'peers_updated', count: peers.length, peerIds: peers.map(p => p.peerId) }
    })
  })
}

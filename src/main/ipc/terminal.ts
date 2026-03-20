import { ipcMain } from 'electron'
import { existsSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { bus } from '../event-bus'
import { writeMCPConfigToWorkspace } from '../mcp-server'

function ensureNodePtySpawnHelperExecutable(): void {
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

function expandHome(arg: string): string {
  if (!arg.startsWith('~')) return arg
  const home = homedir()
  if (arg === '~') return home

  // Backward compatibility: older builds passed ~/.clawd-collab..., while runtime
  // config now lives in ~/clawd-collab. Keep both working.
  if (arg.startsWith('~/.clawd-collab/')) {
    return join(home, 'clawd-collab', arg.slice('~/.clawd-collab/'.length))
  }
  if (arg.startsWith('~\\.clawd-collab\\')) {
    return join(home, 'clawd-collab', arg.slice('~\\.clawd-collab\\'.length))
  }

  if (arg.startsWith('~/') || arg.startsWith('~\\')) return join(home, arg.slice(2))
  return arg
}

interface PtyInstance {
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  onData: (cb: (data: string) => void) => void
}

const terminals = new Map<string, PtyInstance>()
const terminalBuffers = new Map<string, { data: string; timer: ReturnType<typeof setTimeout> | undefined }>()
const TERMINAL_BUS_DEBOUNCE = 800 // ms

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
  ipcMain.handle('terminal:create', (event, tileId: string, workspaceDir: string, launchBin?: string, launchArgs?: string[]) => {
    // Kill any existing terminal with this id
    if (terminals.has(tileId)) {
      try { terminals.get(tileId)!.kill() } catch { /* ignore */ }
      terminals.delete(tileId)
    }

    // If a binary is specified, spawn it directly (no shell wrapper)
    const bin = launchBin || process.env.SHELL || '/bin/zsh'
    const args = launchBin ? (launchArgs ?? []).map(expandHome) : []

    // Check if we should inject MCP config for agent CLIs
    const agentBins = ['claude', 'codex', 'aider', 'opencode']
    const isAgent = launchBin && agentBins.some(a => launchBin.includes(a))
    const spawnEnv: Record<string, string> = { ...process.env as Record<string, string>, CARD_ID: tileId }
    if (isAgent) {
      const mcpConfigPath = join(homedir(), 'clawd-collab', 'mcp-server.json')
      spawnEnv.COLLABORATOR_MCP_CONFIG = mcpConfigPath

      // Auto-allow collaborator MCP tools for Claude Code CLI launches
      const isClaude = launchBin.includes('claude')
      if (isClaude) {
        const mcpToolNames = [
          'mcp__collaborator__canvas_create_tile', 'mcp__collaborator__canvas_open_file',
          'mcp__collaborator__canvas_pan_to', 'mcp__collaborator__canvas_list_tiles',
          'mcp__collaborator__card_complete', 'mcp__collaborator__card_update',
          'mcp__collaborator__card_error', 'mcp__collaborator__canvas_event',
          'mcp__collaborator__request_input', 'mcp__collaborator__update_progress',
          'mcp__collaborator__log_activity', 'mcp__collaborator__create_task',
          'mcp__collaborator__update_task', 'mcp__collaborator__notify',
          'mcp__collaborator__ask',
        ]
        args.push('--allowedTools', mcpToolNames.join(','))
      }

      bus.publish({
        channel: `tile:${tileId}`,
        type: 'system',
        source: `terminal:${tileId}`,
        payload: { action: 'agent_launched', agent: launchBin }
      })
    }

    // Ensure .mcp.json exists in workspace so Claude Code auto-discovers collaborator tools
    writeMCPConfigToWorkspace(workspaceDir).catch(() => {})

    const term: PtyInstance = pty.spawn(bin, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: workspaceDir,
      env: spawnEnv
    })

    terminals.set(tileId, term)

    bus.publish({
      channel: `tile:${tileId}`,
      type: 'system',
      source: `terminal:${tileId}`,
      payload: { action: 'created', workspaceDir }
    })

    term.onData((data: string) => {
      try {
        if (!event.sender.isDestroyed()) {
          event.sender.send(`terminal:data:${tileId}`, data)
          event.sender.send(`terminal:active:${tileId}`)
        }
      } catch { /* renderer may have been destroyed */ }

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

    return { cols: 80, rows: 24 }
  })

  ipcMain.handle('terminal:write', (_, tileId: string, data: string) => {
    terminals.get(tileId)?.write(data)
  })

  ipcMain.handle('terminal:resize', (_, tileId: string, cols: number, rows: number) => {
    if (cols > 0 && rows > 0) {
      terminals.get(tileId)?.resize(Math.floor(cols), Math.floor(rows))
    }
  })

  ipcMain.handle('terminal:destroy', (_, tileId: string) => {
    const term = terminals.get(tileId)
    if (term) {
      try { term.kill() } catch { /* ignore */ }
      terminals.delete(tileId)
    }
    bus.publish({
      channel: `tile:${tileId}`,
      type: 'system',
      source: `terminal:${tileId}`,
      payload: { action: 'destroyed' }
    })
    // Clean up buffer
    const buf = terminalBuffers.get(tileId)
    if (buf?.timer) clearTimeout(buf.timer)
    terminalBuffers.delete(tileId)
  })
}

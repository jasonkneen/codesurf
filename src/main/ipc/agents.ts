import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { whichSync } from '../agent-paths'

export interface AgentInfo {
  id: string
  label: string
  cmd: string
  path?: string
  version?: string
  available: boolean
}

const AGENTS_TO_DETECT: Array<Omit<AgentInfo, 'available' | 'path' | 'version'> & { bins: string[]; versionFlag?: string }> = [
  {
    id: 'claude',
    label: 'Claude Code',
    cmd: 'claude',
    bins: ['claude', '/usr/local/bin/claude', `${homedir()}/.bun/bin/claude`, `${homedir()}/.npm-global/bin/claude`, `${homedir()}/.local/bin/claude`],
    versionFlag: '--version'
  },
  {
    id: 'codex',
    label: 'Codex',
    cmd: 'codex',
    bins: ['codex', '/usr/local/bin/codex', `${homedir()}/.bun/bin/codex`, `${homedir()}/.npm-global/bin/codex`],
    versionFlag: '--version'
  },
  {
    id: 'cursor',
    label: 'Cursor',
    cmd: 'cursor',
    bins: [
      'cursor',
      '/usr/local/bin/cursor',
      '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
      `${homedir()}/Applications/Cursor.app/Contents/Resources/app/bin/cursor`
    ],
    versionFlag: '--version'
  },
  {
    id: 'aider',
    label: 'Aider',
    cmd: 'aider',
    bins: ['aider', '/usr/local/bin/aider', `${homedir()}/.local/bin/aider`, `${homedir()}/.bun/bin/aider`],
    versionFlag: '--version'
  },
  {
    id: 'goose',
    label: 'Goose',
    cmd: 'goose',
    bins: ['goose', '/usr/local/bin/goose', `${homedir()}/.local/bin/goose`],
    versionFlag: '--version'
  },
  {
    id: 'continue',
    label: 'Continue',
    cmd: 'continue',
    bins: ['continue', `${homedir()}/.continue/bin/continue`],
    versionFlag: '--version'
  },
  {
    id: 'cline',
    label: 'Cline',
    cmd: 'cline',
    bins: ['cline', `${homedir()}/.bun/bin/cline`, `${homedir()}/.npm-global/bin/cline`],
    versionFlag: '--version'
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    cmd: 'gemini',
    bins: ['gemini', '/usr/local/bin/gemini', `${homedir()}/.bun/bin/gemini`, `${homedir()}/.npm-global/bin/gemini`],
    versionFlag: '--version'
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    cmd: 'opencode',
    bins: ['opencode', '/usr/local/bin/opencode', `${homedir()}/.bun/bin/opencode`],
    versionFlag: '--version'
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    cmd: 'openclaw',
    bins: ['openclaw', '/usr/local/bin/openclaw', '/opt/homebrew/bin/openclaw', `${homedir()}/.local/bin/openclaw`, `${homedir()}/.cargo/bin/openclaw`],
    versionFlag: '--version'
  },
  {
    id: 'hermes',
    label: 'Hermes',
    cmd: 'hermes',
    bins: ['hermes', '/usr/local/bin/hermes', `${homedir()}/.local/bin/hermes`, `${homedir()}/.hermes/bin/hermes`, `${homedir()}/Documents/GitHub/hermes-agent/hermes`],
    versionFlag: '--version'
  },
  {
    id: 'shell',
    label: 'Shell',
    cmd: process.platform === 'win32' ? (process.env.COMSPEC ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/zsh'),
    bins: process.platform === 'win32'
      ? [process.env.COMSPEC ?? 'cmd.exe', 'powershell.exe', 'pwsh.exe']
      : [process.env.SHELL ?? '/bin/zsh'],
    versionFlag: '--version'
  }
]

async function fileExists(path: string): Promise<boolean> {
  try { await fs.access(path); return true } catch { return false }
}

/** Run a program with literal args — no shell, so agent names can't be
 *  interpreted as shell metacharacters. */
function runExec(prog: string, args: string[]): Promise<string> {
  return new Promise(resolve => {
    execFile(prog, args, { timeout: 3000 }, (err, stdout, stderr) => {
      resolve(err ? '' : (stdout || stderr).toString().trim())
    })
  })
}

function extractVersion(out: string): string | undefined {
  const match = out.match(/[\d]+\.[\d]+[\d.]*/)
  if (match) return match[0]
  const firstLine = out.split('\n')[0]?.trim()
  return firstLine ? firstLine.substring(0, 30) : undefined
}

async function detectAgent(agent: typeof AGENTS_TO_DETECT[0]): Promise<AgentInfo> {
  // The shell agent's --version flag yields meaningless output on Windows
  // (cmd.exe/powershell don't implement it), so we skip version probing
  // for it entirely. The UI just displays its label.
  const probeVersion = agent.id !== 'shell' && !!agent.versionFlag

  // Try each bin path. Bare names (no path separator) fall through to a
  // PATH lookup via whichSync — important on Windows where bins like
  // `powershell.exe` / `pwsh.exe` aren't locatable by fileExists alone.
  for (const bin of agent.bins) {
    let resolved: string | null = null
    if (await fileExists(bin).catch(() => false)) {
      resolved = bin
    } else if (!/[\\/]/.test(bin)) {
      resolved = whichSync(bin)
    }
    if (resolved) {
      const version = probeVersion
        ? extractVersion(await runExec(resolved, [agent.versionFlag!]))
        : undefined
      return { id: agent.id, label: agent.label, cmd: resolved, path: resolved, version, available: true }
    }
  }

  // Final fallback: whichSync on agent.cmd — uses the hydrated shell PATH
  // (critical for packaged GUI launches where process.env.PATH is minimal)
  // and prefers a native .exe over .cmd/.bat shims on Windows.
  const resolved = whichSync(agent.cmd)
  if (resolved) {
    const version = probeVersion
      ? extractVersion(await runExec(resolved, [agent.versionFlag!]))
      : undefined
    return { id: agent.id, label: agent.label, cmd: resolved, path: resolved, version, available: true }
  }

  return { id: agent.id, label: agent.label, cmd: agent.cmd, available: false }
}

export function registerAgentsIPC(): void {
  ipcMain.handle('agents:detect', async () => {
    const results = await Promise.all(AGENTS_TO_DETECT.map(detectAgent))
    return results
  })
}

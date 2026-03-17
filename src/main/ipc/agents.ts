import { ipcMain } from 'electron'
import { exec } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

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
    id: 'shell',
    label: 'Shell',
    cmd: process.env.SHELL ?? '/bin/zsh',
    bins: [process.env.SHELL ?? '/bin/zsh'],
    versionFlag: '--version'
  }
]

async function fileExists(path: string): Promise<boolean> {
  try { await fs.access(path); return true } catch { return false }
}

function runCmd(cmd: string): Promise<string> {
  return new Promise(resolve => {
    exec(cmd, { timeout: 3000 }, (err, stdout, stderr) => {
      resolve(err ? '' : (stdout || stderr).trim())
    })
  })
}

async function detectAgent(agent: typeof AGENTS_TO_DETECT[0]): Promise<AgentInfo> {
  // Try each bin path
  for (const bin of agent.bins) {
    const exists = await fileExists(bin).catch(() => false)
    if (exists) {
      let version: string | undefined
      if (agent.versionFlag) {
        const out = await runCmd(`"${bin}" ${agent.versionFlag} 2>&1`)
        const match = out.match(/[\d]+\.[\d]+[\d.]*/)
        version = match ? match[0] : out.split('\n')[0].substring(0, 30)
      }
      return { id: agent.id, label: agent.label, cmd: bin, path: bin, version, available: true }
    }
  }

  // Try which as fallback
  const whichResult = await runCmd(`which ${agent.cmd} 2>/dev/null`)
  if (whichResult && !whichResult.includes('not found')) {
    let version: string | undefined
    if (agent.versionFlag) {
      const out = await runCmd(`${agent.cmd} ${agent.versionFlag} 2>&1`)
      const match = out.match(/[\d]+\.[\d]+[\d.]*/)
      version = match ? match[0] : undefined
    }
    return { id: agent.id, label: agent.label, cmd: whichResult.trim(), path: whichResult.trim(), version, available: true }
  }

  return { id: agent.id, label: agent.label, cmd: agent.cmd, available: false }
}

export function registerAgentsIPC(): void {
  ipcMain.handle('agents:detect', async () => {
    const results = await Promise.all(AGENTS_TO_DETECT.map(detectAgent))
    return results
  })
}

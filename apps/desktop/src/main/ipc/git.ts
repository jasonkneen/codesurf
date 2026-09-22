import { ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'util'
import { existsSync, statSync } from 'fs'
import path from 'node:path'
import { handleTyped, ipcSchemas } from './handleTyped.ts'

const execFileAsync = promisify(execFile)

// Reject branch names that git would parse as options (leading '-') or that
// contain control characters. execFile already prevents shell-metachar
// injection, but a name like `--foo` would still be interpreted as a git flag.
function assertSafeBranchName(name: string): string {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) throw new Error('Empty branch name')
  if (trimmed.startsWith('-')) throw new Error('Invalid branch name: leading dash')
  if (/\p{Cc}/u.test(trimmed)) throw new Error('Invalid branch name: control character')
  return trimmed
}

export type GitStatus = 'modified' | 'untracked' | 'added' | 'deleted' | 'renamed' | 'conflict'

export interface GitFileStatus {
  path: string   // relative to repo root
  status: GitStatus
}

export interface GitStatusResult {
  isRepo: boolean
  root: string
  files: GitFileStatus[]
}

export interface GitBranchSummary {
  name: string
  current: boolean
}

export interface GitBranchesResult {
  isRepo: boolean
  root: string
  current: string | null
  branches: GitBranchSummary[]
}

function parseStatus(code: string): GitStatus {
  if (code === '??' || code === '!!') return 'untracked'
  if (code.includes('A')) return 'added'
  if (code.includes('D')) return 'deleted'
  if (code.includes('R')) return 'renamed'
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflict'
  return 'modified'
}

export function registerGitIPC(): void {
  ipcMain.handle('git:status', async (_, dirPath: string): Promise<GitStatusResult> => {
    try {
      // SEC-05: Validate that dirPath exists and is a directory
      const resolvedDir = path.resolve(dirPath)
      if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
        return { isRepo: false, root: dirPath, files: [] }
      }

      // Find repo root — use execFile to avoid shell interpretation
      const { stdout: rootRaw } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: resolvedDir })
      const root = rootRaw.trim()

      // Get porcelain status
      const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-u'], { cwd: root })
      const files: GitFileStatus[] = []

      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        const xy = line.slice(0, 2)
        const rest = line.slice(3).trim()
        // Handle renames: "old -> new"
        const filePath = rest.includes(' -> ') ? rest.split(' -> ')[1] : rest
        files.push({ path: filePath, status: parseStatus(xy.trim()) })
      }

      return { isRepo: true, root, files }
    } catch {
      return { isRepo: false, root: dirPath, files: [] }
    }
  })

  ipcMain.handle('git:branches', async (_, dirPath: string): Promise<GitBranchesResult> => {
    try {
      const resolvedDir = path.resolve(dirPath)
      if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
        return { isRepo: false, root: dirPath, current: null, branches: [] }
      }

      const { stdout: rootRaw } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: resolvedDir })
      const root = rootRaw.trim()
      const { stdout: currentRaw } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })
      const current = currentRaw.trim() || null
      const { stdout: branchRaw } = await execFileAsync('git', ['for-each-ref', '--format=%(refname:short)|%(HEAD)', 'refs/heads'], { cwd: root })

      const branches = branchRaw
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          const [name, headMarker] = line.split('|')
          return {
            name: name.trim(),
            current: headMarker?.trim() === '*' || name.trim() === current,
          }
        })

      return { isRepo: true, root, current, branches }
    } catch {
      return { isRepo: false, root: dirPath, current: null, branches: [] }
    }
  })

  handleTyped('git:checkoutBranch', {
    args: [ipcSchemas.boundedString(), ipcSchemas.boundedString(512)] as const,
    handler: async (_evt, dirPath, branchName): Promise<{ ok: boolean; error?: string }> => {
    try {
      const resolvedDir = path.resolve(dirPath)
      if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
        return { ok: false, error: 'Directory not found' }
      }
      const branch = assertSafeBranchName(branchName)
      const { stdout: rootRaw } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: resolvedDir })
      const root = rootRaw.trim()
      await execFileAsync('git', ['checkout', '--end-of-options', branch], { cwd: root })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'checkout-failed' }
    }
    },
  })

  handleTyped('git:createBranch', {
    args: [ipcSchemas.boundedString(), ipcSchemas.boundedString(512)] as const,
    handler: async (_evt, dirPath, branchName): Promise<{ ok: boolean; error?: string }> => {
    try {
      const resolvedDir = path.resolve(dirPath)
      if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
        return { ok: false, error: 'Directory not found' }
      }
      const branch = assertSafeBranchName(branchName)
      const { stdout: rootRaw } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: resolvedDir })
      const root = rootRaw.trim()
      await execFileAsync('git', ['checkout', '-b', branch], { cwd: root })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'create-branch-failed' }
    }
    },
  })
}

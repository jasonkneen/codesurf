import { promises as fs } from 'fs'
import { join } from 'path'

const GITIGNORE_ENTRIES = [
  '.mcp.json',
  '.codesurf/mcp-server.json',
]

export async function ensureWorkspaceSecretsGitignored(workspacePath: string): Promise<void> {
  const root = String(workspacePath ?? '').trim()
  if (!root) return

  const gitignorePath = join(root, '.gitignore')
  let existing = ''
  try {
    existing = await fs.readFile(gitignorePath, 'utf8')
  } catch {
    // create on first write
  }

  const lines = new Set(existing.split(/\r?\n/).filter(Boolean))
  let changed = false
  for (const entry of GITIGNORE_ENTRIES) {
    if (!lines.has(entry)) {
      lines.add(entry)
      changed = true
    }
  }
  if (!changed) return

  const next = `${Array.from(lines).join('\n')}\n`
  await fs.writeFile(gitignorePath, next)
}
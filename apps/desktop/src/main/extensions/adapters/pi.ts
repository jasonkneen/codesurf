/**
 * Pi agent skill adapter.
 *
 * Pi skills have:
 *   - SKILL.md describing the skill
 *   - Usually tool-based (shell commands, file operations)
 *   - Optional extension config
 *
 * Compatibility approach:
 *   - Each skill becomes a power tier extension
 *   - SKILL.md description → extension description
 *   - If the skill has CLI tools, they become MCP tools
 *   - The skill's location is used as the extension path
 *
 * Effort level: LOW — Pi skills are already tool-shaped. The main work is
 * parsing SKILL.md for metadata and wrapping CLI invocations as MCP tool
 * handlers. No UI rendering needed unless the skill has a TUI component.
 */

import { promises as fs } from 'fs'
import { join, basename } from 'path'
import type { ExtensionAdapter } from './types'
import type { ExtensionManifest } from '../../../shared/types'

export const piAdapter: ExtensionAdapter = {
  name: 'pi-skill',

  async canLoad(dir: string): Promise<boolean> {
    try {
      await fs.access(join(dir, 'SKILL.md'))
      return true
    } catch {
      return false
    }
  },

  async toManifest(dir: string): Promise<ExtensionManifest> {
    const dirName = basename(dir)
    const skillMd = await fs.readFile(join(dir, 'SKILL.md'), 'utf8')

    // Parse basic metadata from SKILL.md
    const nameMatch = skillMd.match(/^#\s+(.+)/m)
    const descMatch = skillMd.match(/^(?:description|Description):\s*(.+)/m)
      ?? skillMd.match(/^[^#\n].{10,100}/m) // fallback: first substantial line

    const name = nameMatch?.[1]?.trim() ?? dirName
    const description = descMatch?.[1]?.trim() ?? `Pi skill: ${dirName}`

    // Look for tool definitions (common patterns in SKILL.md)
    const tools = extractToolsFromSkillMd(skillMd, dirName)

    // Check if there's a main.js or index.js for power tier
    let main: string | undefined
    for (const candidate of ['main.js', 'index.js', 'dist/index.js']) {
      try {
        await fs.access(join(dir, candidate))
        main = candidate
        break
      } catch { /**/ }
    }

    return {
      id: `pi-${dirName}`,
      name,
      version: '1.0.0',
      description,
      tier: main ? 'power' : 'safe',
      main,
      contributes: {
        mcpTools: tools.length > 0 ? tools : undefined,
      },
      permissions: ['shell:exec'],
      _path: dir,
      _enabled: true,
      _adapter: 'pi-skill',
    }
  },
}

function extractToolsFromSkillMd(md: string, dirName: string): Array<{
  name: string
  description: string
  inputSchema: Record<string, unknown>
}> {
  // Look for code blocks that look like CLI invocations
  const tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = []

  // Pattern: ```bash\n<command>\n```
  const codeBlocks = md.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)
  const commands = new Set<string>()

  for (const match of codeBlocks) {
    const lines = match[1].trim().split('\n')
    for (const line of lines) {
      const cmd = line.replace(/^\$\s*/, '').trim()
      if (cmd && !cmd.startsWith('#') && cmd.length < 80) {
        commands.add(cmd.split(/\s+/)[0])
      }
    }
  }

  // Create a tool for each unique command found
  for (const cmd of commands) {
    if (['cd', 'echo', 'cat', 'ls', 'mkdir'].includes(cmd)) continue
    tools.push({
      name: `pi_${dirName}_${cmd}`.replace(/[^a-zA-Z0-9_]/g, '_'),
      description: `Run ${cmd} from pi skill: ${dirName}`,
      inputSchema: {
        type: 'object',
        properties: {
          args: { type: 'string', description: 'Arguments to pass to the command' },
        },
      },
    })
  }

  return tools
}

/**
 * OpenClaw extension adapter.
 *
 * OpenClaw extensions are similar to pi skills but with a different manifest
 * format and a focus on AI agent tooling.
 *
 * Expected structure:
 *   - openclaw.json or .openclaw/config.json manifest
 *   - Tools defined as functions with typed inputs/outputs
 *   - Optional React UI components
 *
 * Compatibility approach:
 *   - Tools → MCP tool contributions
 *   - UI components → tile contributions (loaded via iframe shim)
 *   - Config/secrets → extension settings
 *
 * Effort level: LOW-MEDIUM — OpenClaw tools are already MCP-shaped.
 * UI components need a React shim similar to the Raycast adapter.
 */

import { promises as fs } from 'fs'
import { join, basename } from 'path'
import type { ExtensionAdapter } from './types'
import type { ExtensionManifest } from '../../../shared/types'

interface OpenClawConfig {
  name: string
  version?: string
  description?: string
  tools?: Array<{
    name: string
    description: string
    parameters?: Record<string, unknown>
  }>
  ui?: Array<{
    name: string
    title: string
    entry: string
  }>
}

export const openclawAdapter: ExtensionAdapter = {
  name: 'openclaw',

  async canLoad(dir: string): Promise<boolean> {
    try {
      await fs.access(join(dir, 'openclaw.json'))
      return true
    } catch {
      try {
        await fs.access(join(dir, '.openclaw', 'config.json'))
        return true
      } catch {
        return false
      }
    }
  },

  async toManifest(dir: string): Promise<ExtensionManifest> {
    const dirName = basename(dir)
    let config: OpenClawConfig

    try {
      const raw = await fs.readFile(join(dir, 'openclaw.json'), 'utf8')
      config = JSON.parse(raw)
    } catch {
      const raw = await fs.readFile(join(dir, '.openclaw', 'config.json'), 'utf8')
      config = JSON.parse(raw)
    }

    const mcpTools = (config.tools ?? []).map(tool => ({
      name: `oc_${dirName}_${tool.name}`.replace(/[^a-zA-Z0-9_]/g, '_'),
      description: tool.description,
      inputSchema: {
        type: 'object' as const,
        properties: tool.parameters ?? {},
      },
    }))

    const tiles = (config.ui ?? []).map(ui => ({
      type: `ext:oc-${dirName}-${ui.name}`,
      label: ui.title,
      icon: '🦀',
      entry: ui.entry,
      defaultSize: { w: 500, h: 400 },
      minSize: { w: 300, h: 200 },
    }))

    return {
      id: `openclaw-${dirName}`,
      name: config.name ?? dirName,
      version: config.version ?? '1.0.0',
      description: config.description ?? `OpenClaw extension: ${dirName}`,
      tier: mcpTools.length > 0 ? 'power' : 'safe',
      contributes: {
        tiles: tiles.length > 0 ? tiles : undefined,
        mcpTools: mcpTools.length > 0 ? mcpTools : undefined,
      },
      _path: dir,
      _enabled: true,
      _adapter: 'openclaw',
    }
  },
}

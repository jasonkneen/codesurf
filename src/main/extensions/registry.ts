/**
 * Extension registry — scans, validates, and manages contex extensions.
 *
 * Extensions live in:
 *   ~/.contex/extensions/       (global)
 *   {workspace}/.contex/extensions/  (per-workspace, loaded later)
 *
 * Each extension dir contains an extension.json manifest.
 */

import { promises as fs } from 'fs'
import { join, resolve } from 'path'
import { CONTEX_HOME } from '../paths'
import { ExtensionContext } from './context'
import { loadPowerExtension } from './loader'
import { bus } from '../event-bus'
import { tryAdaptExtension } from './adapters'
import type { ExtensionManifest, ExtensionTileContrib, ExtensionMCPToolContrib, ExtensionContextMenuContrib } from '../../shared/types'

export interface LoadedExtension {
  manifest: ExtensionManifest
  deactivate?: () => void
}

const EXTENSIONS_DIRNAME = 'extensions'

export class ExtensionRegistry {
  private extensions = new Map<string, LoadedExtension>()
  private extraMCPTools: Array<ExtensionMCPToolContrib & { extId: string; handler?: (args: Record<string, unknown>) => Promise<string> }> = []

  async scan(): Promise<void> {
    const globalDir = join(CONTEX_HOME, EXTENSIONS_DIRNAME)
    await this.scanDir(globalDir)
  }

  async scanWorkspace(workspacePath: string): Promise<void> {
    const wsDir = join(workspacePath, '.contex', EXTENSIONS_DIRNAME)
    await this.scanDir(wsDir)
  }

  private async scanDir(dir: string): Promise<void> {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return // dir doesn't exist yet — that's fine
    }

    for (const name of entries) {
      if (name.startsWith('.')) continue
      const extDir = join(dir, name)
      const stat = await fs.stat(extDir).catch(() => null)
      if (!stat?.isDirectory()) continue

      try {
        await this.loadExtension(extDir)
      } catch {
        // Not a native contex extension — try adapters
        try {
          const adapted = await tryAdaptExtension(extDir)
          if (adapted) {
            await this.loadFromManifest(adapted)
          }
        } catch (err) {
          console.error(`[Extensions] Failed to load ${extDir}:`, err)
        }
      }
    }
  }

  private async loadExtension(extDir: string): Promise<void> {
    const manifestPath = join(extDir, 'extension.json')
    const raw = await fs.readFile(manifestPath, 'utf8')
    const manifest: ExtensionManifest = JSON.parse(raw)

    // Validate required fields
    if (!manifest.id || !manifest.name || !manifest.version) {
      throw new Error(`Invalid manifest in ${extDir}: missing id, name, or version`)
    }
    if (!manifest.tier) manifest.tier = 'safe'

    // Attach runtime metadata
    manifest._path = resolve(extDir)
    manifest._enabled = manifest._enabled !== false

    // Namespace tile types with ext: prefix
    if (manifest.contributes?.tiles) {
      for (const tile of manifest.contributes.tiles) {
        if (!tile.type.startsWith('ext:')) {
          tile.type = `ext:${tile.type}`
        }
      }
    }

    // Skip if already loaded (workspace overrides global)
    if (this.extensions.has(manifest.id)) {
      const existing = this.extensions.get(manifest.id)!
      // Workspace extensions override global — deactivate old one
      if (existing.deactivate) existing.deactivate()
      this.extensions.delete(manifest.id)
    }

    const loaded: LoadedExtension = { manifest }

    // Load power tier extensions
    if (manifest.tier === 'power' && manifest.main && manifest._enabled) {
      const ctx = new ExtensionContext(manifest, bus, this)
      const deactivate = await loadPowerExtension(manifest, ctx)
      loaded.deactivate = deactivate ?? undefined

      // Collect MCP tools registered by the extension
      for (const tool of ctx.getRegisteredTools()) {
        this.extraMCPTools.push({ ...tool, extId: manifest.id })
      }
    }

    this.extensions.set(manifest.id, loaded)
    console.log(`[Extensions] Loaded: ${manifest.name} v${manifest.version} (${manifest.tier})`)
  }

  /** Load an already-parsed manifest (used by adapters) */
  async loadFromManifest(manifest: ExtensionManifest): Promise<void> {
    if (this.extensions.has(manifest.id)) return

    // Namespace tiles
    if (manifest.contributes?.tiles) {
      for (const tile of manifest.contributes.tiles) {
        if (!tile.type.startsWith('ext:')) {
          tile.type = `ext:${tile.type}`
        }
      }
    }

    const loaded: LoadedExtension = { manifest }

    if (manifest.tier === 'power' && manifest.main && manifest._enabled && manifest._path) {
      const ctx = new ExtensionContext(manifest, bus, this)
      const deactivate = await loadPowerExtension(manifest, ctx)
      loaded.deactivate = deactivate ?? undefined
      for (const tool of ctx.getRegisteredTools()) {
        this.extraMCPTools.push({ ...tool, extId: manifest.id })
      }
    }

    this.extensions.set(manifest.id, loaded)
    console.log(`[Extensions] Loaded (adapted): ${manifest.name} v${manifest.version}`)
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  getAll(): ExtensionManifest[] {
    return [...this.extensions.values()].map(e => e.manifest)
  }

  get(id: string): LoadedExtension | undefined {
    return this.extensions.get(id)
  }

  getTileTypes(): ExtensionTileContrib[] {
    const tiles: ExtensionTileContrib[] = []
    for (const ext of this.extensions.values()) {
      if (!ext.manifest._enabled) continue
      if (ext.manifest.contributes?.tiles) {
        for (const tile of ext.manifest.contributes.tiles) {
          tiles.push({ ...tile, extId: ext.manifest.id })
        }
      }
    }
    return tiles
  }

  getMCPTools(): Array<ExtensionMCPToolContrib & { extId: string; handler?: (args: Record<string, unknown>) => Promise<string> }> {
    const tools: typeof this.extraMCPTools = []
    // Declarative tools from manifests
    for (const ext of this.extensions.values()) {
      if (!ext.manifest._enabled) continue
      if (ext.manifest.contributes?.mcpTools) {
        for (const tool of ext.manifest.contributes.mcpTools) {
          tools.push({ ...tool, extId: ext.manifest.id })
        }
      }
    }
    // Programmatic tools from power tier activate()
    tools.push(...this.extraMCPTools)
    return tools
  }

  getContextMenuItems(): ExtensionContextMenuContrib[] {
    const items: ExtensionContextMenuContrib[] = []
    for (const ext of this.extensions.values()) {
      if (!ext.manifest._enabled) continue
      if (ext.manifest.contributes?.contextMenu) {
        for (const item of ext.manifest.contributes.contextMenu) {
          items.push({ ...item, extId: ext.manifest.id })
        }
      }
    }
    return items
  }

  getTileEntry(extId: string, tileType: string): string | null {
    const ext = this.extensions.get(extId)
    if (!ext?.manifest._path || !ext.manifest._enabled) return null
    const tile = ext.manifest.contributes?.tiles?.find(t => t.type === tileType)
    if (!tile) return null
    return `file://${join(ext.manifest._path, tile.entry)}`
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  enable(id: string): boolean {
    const ext = this.extensions.get(id)
    if (!ext) return false
    ext.manifest._enabled = true
    return true
  }

  disable(id: string): boolean {
    const ext = this.extensions.get(id)
    if (!ext) return false
    ext.manifest._enabled = false
    if (ext.deactivate) {
      ext.deactivate()
      ext.deactivate = undefined
    }
    return true
  }

  deactivateAll(): void {
    for (const ext of this.extensions.values()) {
      if (ext.deactivate) ext.deactivate()
    }
  }

  /** Register a programmatic MCP tool (called from ExtensionContext) */
  registerMCPTool(extId: string, tool: ExtensionMCPToolContrib & { handler?: (args: Record<string, unknown>) => Promise<string> }): void {
    this.extraMCPTools.push({ ...tool, extId })
  }
}

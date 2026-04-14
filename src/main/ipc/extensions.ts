/**
 * IPC handlers for the extension system.
 * Exposes ext:* channels to the renderer.
 */

import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join, basename } from 'path'
import { createReadStream } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ExtensionRegistry } from '../extensions/registry'
import { getBridgeScript } from '../extensions/bridge'
import { CONTEX_HOME } from '../paths'
import { readSettingsSync } from './workspace'

const execFileAsync = promisify(execFile)
const EXTENSIONS_DIR = join(CONTEX_HOME, 'extensions')

function extensionSettingsPath(extId: string): string {
  return join(CONTEX_HOME, 'extension-settings', `${extId}.json`)
}

async function readExtensionSettings(registry: ExtensionRegistry, extId: string): Promise<Record<string, unknown>> {
  const ext = registry.get(extId)
  if (!ext) return {}

  const defaults: Record<string, unknown> = {}
  for (const s of ext.manifest.contributes?.settings ?? []) {
    defaults[s.key] = s.default
  }

  try {
    const raw = await fs.readFile(extensionSettingsPath(extId), 'utf8')
    return { ...defaults, ...(JSON.parse(raw) as Record<string, unknown>) }
  } catch {
    return defaults
  }
}

export function registerExtensionIPC(registry: ExtensionRegistry): void {
  let lastScannedWorkspacePath: string | null = null
  let hasScanned = false

  const ensureLoaded = async (workspacePath?: string | null, force = false): Promise<void> => {
    const settings = readSettingsSync()
    if (settings.extensionsDisabled) {
      lastScannedWorkspacePath = null
      hasScanned = false
      return
    }

    const targetWorkspacePath = workspacePath ?? registry.getActiveWorkspacePath() ?? null
    if (!force && hasScanned && lastScannedWorkspacePath === targetWorkspacePath) return

    await registry.rescan(targetWorkspacePath)
    lastScannedWorkspacePath = targetWorkspacePath
    hasScanned = true
  }

  // List all loaded extensions
  ipcMain.handle('ext:list', async () => {
    await ensureLoaded()
    return registry.getAll().map(m => ({
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      author: m.author,
      tier: m.tier,
      ui: m.ui,
      enabled: m._enabled !== false,
      contributes: m.contributes,
      dirPath: m._path ?? null,
    }))
  })

  // List contributed tile types (for renderer to add to context menu / addTile)
  ipcMain.handle('ext:list-tiles', async () => {
    await ensureLoaded()
    const extActions = registry.getExtensionActions()
    return registry.getTileTypes().map(t => {
      const actions = extActions.get(t.extId)
      return {
        extId: t.extId,
        type: t.type,
        label: t.label,
        icon: t.icon,
        defaultSize: t.defaultSize ?? { w: 400, h: 300 },
        minSize: t.minSize ?? { w: 200, h: 150 },
        uiMode: t.uiMode,
        actions,
      }
    })
  })

  // Get the custom protocol URL for a tile's entry HTML
  ipcMain.handle('ext:tile-entry', async (_, extId: string, tileType: string, tileId?: string) => {
    await ensureLoaded()
    const url = registry.getTileEntry(extId, tileType, tileId)
    return url
  })

  // Get the bridge script to inject into extension iframes
  ipcMain.handle('ext:get-bridge-script', (_, tileId: string, extId: string) => {
    return getBridgeScript(tileId, extId)
  })

  // Enable/disable an extension
  ipcMain.handle('ext:enable', (_, extId: string) => {
    return registry.enable(extId)
  })

  ipcMain.handle('ext:disable', (_, extId: string) => {
    return registry.disable(extId)
  })

  ipcMain.handle('ext:refresh', async (_, workspacePath?: string | null) => {
    if (readSettingsSync().extensionsDisabled) {
      console.log('[Extensions] Refresh skipped — extensions globally disabled')
      lastScannedWorkspacePath = null
      hasScanned = false
      return []
    }
    await ensureLoaded(workspacePath ?? registry.getActiveWorkspacePath(), true)
    return registry.getAll().map(m => ({
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      author: m.author,
      tier: m.tier,
      ui: m.ui,
      enabled: m._enabled !== false,
      contributes: m.contributes,
    }))
  })


  // Extension settings (persisted in ~/.contex/extension-settings/{extId}.json)
  ipcMain.handle('ext:settings-get', async (_, extId: string) => {
    return readExtensionSettings(registry, extId)
  })

  ipcMain.handle('ext:settings-set', async (_, extId: string, settings: Record<string, unknown>) => {
    const ext = registry.get(extId)
    if (!ext) return false

    const allowedKeys = new Set((ext.manifest.contributes?.settings ?? []).map(setting => setting.key))
    const filtered = Object.fromEntries(
      Object.entries(settings ?? {}).filter(([key]) => allowedKeys.has(key)),
    )

    await fs.mkdir(join(CONTEX_HOME, 'extension-settings'), { recursive: true })
    await fs.writeFile(extensionSettingsPath(extId), JSON.stringify(filtered, null, 2))
    return true
  })

  // List context menu contributions
  ipcMain.handle('ext:context-menu-items', () => {
    return registry.getContextMenuItems()
  })

  // Install a .vsix file — extract and register as an extension
  ipcMain.handle('ext:install-vsix', async (_, vsixPath: string) => {
    try {
      const name = basename(vsixPath, '.vsix')
      const destDir = join(EXTENSIONS_DIR, name)

      // Ensure extensions dir exists
      await fs.mkdir(EXTENSIONS_DIR, { recursive: true })

      // vsix files are zip archives — extract with unzip
      // Remove existing dir if present
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => {})
      await fs.mkdir(destDir, { recursive: true })

      // Extract the vsix (it's a zip)
      await execFileAsync('unzip', ['-o', vsixPath, '-d', destDir])

      // vsix archives have content inside extension/ subfolder
      const extensionSubdir = join(destDir, 'extension')
      const hasExtDir = await fs.stat(extensionSubdir).then(s => s.isDirectory()).catch(() => false)

      if (hasExtDir) {
        // Move extension/* up to destDir level
        const items = await fs.readdir(extensionSubdir)
        for (const item of items) {
          await fs.rename(join(extensionSubdir, item), join(destDir, item)).catch(() => {})
        }
        await fs.rm(extensionSubdir, { recursive: true, force: true }).catch(() => {})
      }

      // Clean up vsix metadata files
      for (const junk of ['[Content_Types].xml', '_rels']) {
        await fs.rm(join(destDir, junk), { recursive: true, force: true }).catch(() => {})
      }

      // Rescan to pick up the new extension
      await registry.rescan(registry.getActiveWorkspacePath())

      // Find the newly installed extension
      const all = registry.getAll()
      const installed = all.find(m => m._path === destDir) || all.find(m => m._path?.startsWith(destDir))

      return {
        ok: true,
        extId: installed?.id || name,
        name: installed?.name || name,
        tiles: registry.getTileTypes().filter(t => t.extId === (installed?.id || name)),
      }
    } catch (err) {
      console.error('[ext:install-vsix] Failed:', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

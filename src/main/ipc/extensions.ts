/**
 * IPC handlers for the extension system.
 * Exposes ext:* channels to the renderer.
 */

import { ipcMain } from 'electron'
import type { ExtensionRegistry } from '../extensions/registry'
import { getBridgeScript } from '../extensions/bridge'

export function registerExtensionIPC(registry: ExtensionRegistry): void {

  // List all loaded extensions
  ipcMain.handle('ext:list', () => {
    return registry.getAll().map(m => ({
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      author: m.author,
      tier: m.tier,
      enabled: m._enabled !== false,
      contributes: m.contributes,
    }))
  })

  // List contributed tile types (for renderer to add to context menu / addTile)
  ipcMain.handle('ext:list-tiles', () => {
    return registry.getTileTypes().map(t => ({
      extId: t.extId,
      type: t.type,
      label: t.label,
      icon: t.icon,
      defaultSize: t.defaultSize ?? { w: 400, h: 300 },
      minSize: t.minSize ?? { w: 200, h: 150 },
    }))
  })

  // Get the file:// URL for a tile's entry HTML
  ipcMain.handle('ext:tile-entry', (_, extId: string, tileType: string) => {
    return registry.getTileEntry(extId, tileType)
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

  // Extension settings (per-extension key/value store)
  // For now, returns defaults from manifest — persistence comes in Phase 4
  ipcMain.handle('ext:settings-get', (_, extId: string) => {
    const ext = registry.get(extId)
    if (!ext) return {}
    const settings: Record<string, unknown> = {}
    for (const s of ext.manifest.contributes?.settings ?? []) {
      settings[s.key] = s.default
    }
    return settings
  })

  ipcMain.handle('ext:settings-set', (_, _extId: string, _settings: Record<string, unknown>) => {
    // TODO: persist to ~/.contex/extension-settings/{extId}.json
    return true
  })

  // List context menu contributions
  ipcMain.handle('ext:context-menu-items', () => {
    return registry.getContextMenuItems()
  })
}

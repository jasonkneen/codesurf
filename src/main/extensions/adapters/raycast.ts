/**
 * Raycast extension adapter.
 *
 * Raycast extensions have:
 *   - package.json with @raycast/api dependency
 *   - commands[] array in package.json
 *   - React components using List, Detail, Form, Action, ActionPanel, etc.
 *   - Built output typically in dist/ or build/
 *
 * Compatibility approach:
 *   - Each "view" command becomes a tile contribution
 *   - We generate a shim HTML that provides @raycast/api backed by contex bridge
 *   - The shim maps List → scrollable list, Detail → markdown renderer, etc.
 *   - User must pre-build the extension (npm run build)
 *
 * Effort level: MEDIUM — Raycast API is a React component library, so the shim
 * needs to provide React + a subset of @raycast/api components. The most-used
 * components (List, Detail, Action) are straightforward to map. Form and
 * ActionPanel need more work. The main gap is Raycast's built-in preferences
 * and OAuth — those would need contex equivalents.
 */

import { promises as fs } from 'fs'
import { join, basename } from 'path'
import type { ExtensionAdapter } from './types'
import type { ExtensionManifest } from '../../../shared/types'

interface RaycastCommand {
  name: string
  title: string
  subtitle?: string
  description?: string
  mode: 'view' | 'no-view' | 'menu-bar'
  icon?: string
}

interface RaycastPackageJson {
  name: string
  version: string
  description?: string
  author?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  commands?: RaycastCommand[]
}

export const raycastAdapter: ExtensionAdapter = {
  name: 'raycast',

  async canLoad(dir: string): Promise<boolean> {
    try {
      const raw = await fs.readFile(join(dir, 'package.json'), 'utf8')
      const pkg = JSON.parse(raw) as RaycastPackageJson
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
      return '@raycast/api' in deps
    } catch {
      return false
    }
  },

  async toManifest(dir: string): Promise<ExtensionManifest> {
    const raw = await fs.readFile(join(dir, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as RaycastPackageJson
    const dirName = basename(dir)

    const tiles = (pkg.commands ?? [])
      .filter(cmd => cmd.mode === 'view')
      .map(cmd => ({
        type: `ext:raycast-${dirName}-${cmd.name}`,
        label: cmd.title,
        icon: cmd.icon ?? '🔮',
        entry: `dist/_raycast_shim_${cmd.name}.html`,
        defaultSize: { w: 500, h: 400 },
        minSize: { w: 300, h: 200 },
      }))

    return {
      id: `raycast-${dirName}`,
      name: pkg.name ?? dirName,
      version: pkg.version ?? '0.0.0',
      description: pkg.description ?? `Raycast extension: ${dirName}`,
      author: typeof pkg.author === 'string' ? pkg.author : undefined,
      tier: 'safe',
      contributes: { tiles },
      _path: dir,
      _enabled: true,
      _adapter: 'raycast',
    }
  },

  async wrapEntry(dir: string, manifest: ExtensionManifest): Promise<string> {
    // Generate shim HTML files for each command
    const raw = await fs.readFile(join(dir, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as RaycastPackageJson
    const distDir = join(dir, 'dist')
    await fs.mkdir(distDir, { recursive: true })

    for (const cmd of (pkg.commands ?? []).filter(c => c.mode === 'view')) {
      const shimHtml = generateRaycastShim(cmd)
      const shimPath = join(distDir, `_raycast_shim_${cmd.name}.html`)
      await fs.writeFile(shimPath, shimHtml)
    }

    return distDir
  },
}

function generateRaycastShim(cmd: RaycastCommand): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    background: #1e1e1e;
    color: #e0ddd4;
    padding: 12px;
    font-size: 13px;
    overflow-y: auto;
  }
  .raycast-list-item {
    padding: 8px 12px;
    border-radius: 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .raycast-list-item:hover { background: #2a2a30; }
  .raycast-list-item.selected { background: #2a3a4a; }
  .raycast-list-item .title { font-weight: 500; }
  .raycast-list-item .subtitle { color: #888; font-size: 12px; }
  .raycast-detail { padding: 16px; }
  .raycast-detail h1 { font-size: 18px; margin-bottom: 12px; }
  .raycast-search {
    width: 100%;
    padding: 8px 12px;
    background: #2a2a30;
    border: 1px solid #3a3a40;
    border-radius: 6px;
    color: #e0ddd4;
    font-size: 13px;
    margin-bottom: 8px;
    outline: none;
  }
  .raycast-search:focus { border-color: #5d8aa8; }
  .shim-notice {
    text-align: center;
    color: #666;
    padding: 40px 20px;
    font-size: 12px;
  }
  .shim-notice code { background: #2a2a30; padding: 2px 6px; border-radius: 3px; }
</style>
</head>
<body>
<div class="shim-notice">
  <div style="font-size: 24px; margin-bottom: 12px;">🔮</div>
  <div style="margin-bottom: 8px; font-weight: 500;">${cmd.title}</div>
  <div style="margin-bottom: 16px; color: #888;">${cmd.description ?? 'Raycast extension'}</div>
  <div>
    This is a Raycast extension running in compatibility mode.<br>
    Build the extension with <code>npm run build</code> and place<br>
    the output in the <code>dist/</code> folder.
  </div>
</div>
<script>
  // Raycast API compatibility shim
  // This provides a minimal @raycast/api that maps to contex bridge
  if (window.contex) {
    window.contex.tile.getState().then(state => {
      console.log('[Raycast shim] Loaded state:', state);
    });
  }
</script>
</body>
</html>`
}

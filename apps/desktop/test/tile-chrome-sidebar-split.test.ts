/**
 * Structural tests for TileChrome + Sidebar file-size splits.
 * Drives real shipped module paths (exports + import graph), not re-implemented UI.
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { describe, test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

function exists(rel: string): boolean {
  return existsSync(join(root, rel))
}

describe('TileChrome split', () => {
  test('public TileChrome module still exports TileChrome and fileLabel', () => {
    const src = read('src/renderer/src/components/TileChrome.tsx')
    assert.match(src, /export const TileChrome\s*=/)
    assert.match(src, /export \{ fileLabel \}/)
  })

  test('drawer panels and activity live in sibling tile-chrome modules', () => {
    assert.equal(exists('src/renderer/src/components/tile-chrome/DrawerPanels.tsx'), true)
    assert.equal(exists('src/renderer/src/components/tile-chrome/drawerActivity.ts'), true)
    assert.equal(exists('src/renderer/src/components/tile-chrome/types.ts'), true)
    assert.equal(exists('src/renderer/src/components/tile-chrome/labels.ts'), true)
    assert.equal(exists('src/renderer/src/components/tile-chrome/ResizeHandle.tsx'), true)

    const panels = read('src/renderer/src/components/tile-chrome/DrawerPanels.tsx')
    assert.match(panels, /export function DrawerPanel/)
    const activity = read('src/renderer/src/components/tile-chrome/drawerActivity.ts')
    assert.match(activity, /export function processEvent/)
    assert.match(activity, /export function persistToActivityStore/)
    const labels = read('src/renderer/src/components/tile-chrome/labels.ts')
    assert.match(labels, /export function fileLabel/)
  })

  test('shell imports drawer pieces instead of defining DrawerPanel locally', () => {
    const shell = read('src/renderer/src/components/TileChrome.tsx')
    assert.match(shell, /from '\.\/tile-chrome\/DrawerPanels'/)
    assert.match(shell, /from '\.\/tile-chrome\/drawerActivity'/)
    assert.equal(/function DrawerPanel\(/.test(shell), false)
    assert.equal(/function processEvent\(/.test(shell), false)
  })

  test('canvas tile consumer statically loads the public TileChrome path', () => {
    const consumer = read('src/renderer/src/components/canvas/CanvasTileItem.tsx')
    assert.match(consumer, /import\s+\{\s*TileChrome\s*\}\s+from\s+['"]\.\.\/TileChrome['"]/)
    assert.doesNotMatch(consumer, /LazyTileChrome/)
  })

  test('shipped fileLabel returns type label for bare tiles', async () => {
    const { fileLabel } = await import('../src/renderer/src/components/tile-chrome/labels.ts')
    const label = fileLabel({
      id: 't1',
      type: 'terminal',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      zIndex: 1,
    } as any)
    assert.equal(label, 'Terminal')
  })
})

describe('Sidebar split', () => {
  test('public Sidebar module still exports Sidebar and SidebarFooter', () => {
    const src = read('src/renderer/src/components/Sidebar.tsx')
    assert.match(src, /export function Sidebar\b/)
    assert.match(src, /export \{ SidebarFooter \}/)
  })

  test('session controller lives in sidebar/useSidebarController', () => {
    assert.equal(exists('src/renderer/src/components/sidebar/useSidebarController.tsx'), true)
    const controller = read('src/renderer/src/components/sidebar/useSidebarController.tsx')
    assert.match(controller, /export function useSidebarController/)
    assert.match(controller, /export interface SidebarControllerProps/)
    // Streaming concern lives in the controller, not only the shell
    assert.match(controller, /subscribeChatStreaming/)
    assert.match(controller, /getChatStreamingSnapshot/)
  })

  test('Sidebar shell delegates model work to the controller', () => {
    const shell = read('src/renderer/src/components/Sidebar.tsx')
    assert.match(shell, /from '\.\/sidebar\/useSidebarController'/)
    assert.match(shell, /useSidebarController\(props\)/)
    // Shell should not own the heavy streaming subscription itself
    assert.equal(/subscribeChatStreaming/.test(shell), false)
  })

  test('App sidebar region still imports public Sidebar entry', () => {
    const region = read('src/renderer/src/components/AppSidebarRegion.tsx')
    assert.match(region, /import\(['"]\.\/Sidebar['"]\)/)
  })
})

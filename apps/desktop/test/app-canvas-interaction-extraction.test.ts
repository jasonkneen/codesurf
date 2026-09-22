import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const ROOT_DIR = process.cwd()
const APP_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/App.tsx'), 'utf8')
const WORLD_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/AppCanvasWorldOverlays.tsx'), 'utf8')
const GROUP_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/AppCanvasGroupToolbar.tsx'), 'utf8')
const MINIMAP_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/AppCanvasMinimapOverlay.tsx'), 'utf8')

describe('wave 28 canvas interaction extraction', () => {
  test('App delegates interaction overlays to extracted components', () => {
    expect(APP_SOURCE).toContain("from './components/AppCanvasWorldOverlays'")
    expect(APP_SOURCE).toContain("from './components/AppCanvasGroupToolbar'")
    expect(APP_SOURCE).toContain("from './components/AppCanvasMinimapOverlay'")
    expect(APP_SOURCE).toContain('<AppCanvasWorldOverlays')
    expect(APP_SOURCE).toContain('<AppCanvasGroupToolbar')
    expect(APP_SOURCE).toContain('<AppCanvasMinimapOverlay')
    expect(APP_SOURCE).not.toContain('LazyMinimap')
    expect(APP_SOURCE).not.toContain('Alignment guides')
    expect(APP_SOURCE).not.toContain('Rubber-band selection')
  })

  test('extracted components own interaction UI', () => {
    expect(WORLD_SOURCE).toContain('export function AppCanvasWorldOverlays')
    expect(WORLD_SOURCE).toContain("dragState.type === 'select'")
    expect(GROUP_SOURCE).toContain('export function AppCanvasGroupToolbar')
    expect(GROUP_SOURCE).toContain('selectedTileCount < 2')
    expect(MINIMAP_SOURCE).toContain('export function AppCanvasMinimapOverlay')
    expect(MINIMAP_SOURCE).toContain('LazyMinimap')
  })
})
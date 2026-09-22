import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const ROOT_DIR = process.cwd()
const APP_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/App.tsx'), 'utf8')
const TILES_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/AppCanvasTiles.tsx'), 'utf8')
const ITEM_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/canvas/CanvasTileItem.tsx'), 'utf8')

describe('wave 24 canvas tiles extraction', () => {
  test('App delegates tile loop to AppCanvasTiles', () => {
    expect(APP_SOURCE).toContain("from './components/AppCanvasTiles'")
    expect(APP_SOURCE).toContain('<AppCanvasTiles')
    expect(APP_SOURCE).not.toContain('LazyTileChrome')
    expect(APP_SOURCE).not.toContain('link-sensor-')
    expect(APP_SOURCE).not.toContain('Drag to link blocks')
  })

  test('AppCanvasTiles delegates per-tile rendering to the memoized CanvasTileItem', () => {
    expect(TILES_SOURCE).toContain('export function AppCanvasTiles')
    expect(TILES_SOURCE).toContain('export function filterVisibleCanvasTiles')
    expect(TILES_SOURCE).toContain("from './canvas/CanvasTileItem'")
    expect(TILES_SOURCE).toContain('<CanvasTileItem')
    // Heavy per-tile JSX must NOT live in the map body any more — it moved into the
    // memoized item so an interaction only re-renders the affected tiles.
    expect(TILES_SOURCE).not.toContain('LazyTileChrome')
    expect(TILES_SOURCE).not.toContain('Drag to link blocks')
  })

  test('CanvasTileItem owns tile chrome, link sensors, and connection handles, and is memoized', () => {
    expect(ITEM_SOURCE).toContain("import { TileChrome } from '../TileChrome'")
    expect(ITEM_SOURCE).not.toContain('LazyTileChrome')
    expect(ITEM_SOURCE).toContain('link-sensor-')
    expect(ITEM_SOURCE).toContain('Drag to link blocks')
    expect(ITEM_SOURCE).toContain('getConnectionHandlePoint')
    expect(ITEM_SOURCE).toContain('TileColorProvider')
    expect(ITEM_SOURCE).toContain('React.memo')
  })
})

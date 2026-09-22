import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const ROOT_DIR = process.cwd()
const APP_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/App.tsx'), 'utf8')
const SURFACE_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/AppCanvasSurface.tsx'), 'utf8')
const FILE_TILE_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/lib/fileTileType.ts'), 'utf8')

describe('wave 23 canvas surface extraction', () => {
  test('App delegates canvas chrome to AppCanvasSurface', () => {
    expect(APP_SOURCE).toContain("from './components/AppCanvasSurface'")
    expect(APP_SOURCE).toContain("from './lib/fileTileType'")
    expect(APP_SOURCE).toContain('<AppCanvasSurface')
    expect(APP_SOURCE).not.toContain('data-canvas-surface="true"')
    expect(APP_SOURCE).not.toContain('Dot grid - small')
    expect(APP_SOURCE).not.toContain('function extToType')
  })

  test('AppCanvasSurface owns surface chrome and drop handling', () => {
    expect(SURFACE_SOURCE).toContain('data-canvas-surface="true"')
    expect(SURFACE_SOURCE).toContain('handleDrop')
    expect(SURFACE_SOURCE).toContain('gridColorSmall')
    expect(SURFACE_SOURCE).toContain('dotGlowSmallRef')
    expect(SURFACE_SOURCE).toContain('expandedCanvasGroupId')
  })

  test('file tile helpers live in lib/fileTileType', () => {
    expect(FILE_TILE_SOURCE).toContain('export function extToType')
    expect(FILE_TILE_SOURCE).toContain('export async function resolveFileTileType')
  })
})
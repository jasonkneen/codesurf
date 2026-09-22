import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const ROOT_DIR = process.cwd()
const APP_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/App.tsx'), 'utf8')
const PANEL_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/AppCanvasPanelRegion.tsx'), 'utf8')
const TOOLBAR_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/AppCanvasArrangeToolbar.tsx'), 'utf8')

describe('wave 26 panel region and arrange toolbar extraction', () => {
  test('App delegates panel chrome to extracted components', () => {
    expect(APP_SOURCE).toContain("from './components/AppCanvasPanelRegion'")
    expect(APP_SOURCE).toContain("from './components/AppCanvasArrangeToolbar'")
    expect(APP_SOURCE).toContain('appCanvasPanelRegionProps')
    expect(APP_SOURCE).toContain('<AppCanvasPanelRegion')
    expect(APP_SOURCE).toContain('<AppCanvasArrangeToolbar')
    expect(APP_SOURCE).not.toContain('LazyPanelLayout')
    expect(APP_SOURCE).not.toContain('LazyArrangeToolbar')
    expect(APP_SOURCE).not.toContain('onSplitNew=')
  })

  test('extracted components own panel layout and arrange toolbar', () => {
    expect(PANEL_SOURCE).toContain('export function AppCanvasPanelRegion')
    expect(PANEL_SOURCE).toContain('LazyPanelLayout')
    expect(PANEL_SOURCE).toContain('onSplitNew')
    expect(PANEL_SOURCE).toContain('closeOthersInLeaf')
    expect(TOOLBAR_SOURCE).toContain('export function AppCanvasArrangeToolbar')
    expect(TOOLBAR_SOURCE).toContain('LazyArrangeToolbar')
    expect(TOOLBAR_SOURCE).toContain('onToggleTabs')
    expect(TOOLBAR_SOURCE).toContain('onArrange')
  })
})
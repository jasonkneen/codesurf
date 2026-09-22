import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const ROOT_DIR = process.cwd()
const APP_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/App.tsx'), 'utf8')
const WORKSPACE_HELPERS_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/lib/workspaceHelpers.ts'), 'utf8')
const PANEL_VIEW_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useAppPanelViewMode.ts'), 'utf8')
const CANVAS_VIEW_PROPS_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useAppCanvasViewProps.ts'), 'utf8')

describe('wave 27 orchestration helpers extraction', () => {
  test('App delegates workspace, persistence, and panel orchestration to modules', () => {
    expect(APP_SOURCE).toContain("from './lib/workspaceHelpers'")
    expect(APP_SOURCE).toContain("from './lib/appShellPersistence'")
    expect(APP_SOURCE).toContain("from './lib/canvasStateHelpers'")
    expect(APP_SOURCE).toContain("from './hooks/usePanelTileChrome'")
    expect(APP_SOURCE).toContain("from './hooks/useAppPanelViewMode'")
    expect(APP_SOURCE).toContain("from './hooks/useAppCanvasViewProps'")
    expect(APP_SOURCE).toContain('useAppPanelViewMode(')
    expect(APP_SOURCE).toContain('useAppCanvasConnectionProps(')
    expect(APP_SOURCE).toContain('useAppCanvasPanelRegionProps(')
    expect(APP_SOURCE).not.toContain('function getCanonicalWorkspaceId')
    expect(APP_SOURCE).not.toContain('function promoteExpandedTileToLayoutGroup')
    expect(APP_SOURCE).not.toContain('const appCanvasConnectionProps = React.useMemo')
  })

  test('extracted modules own moved helper and hook logic', () => {
    expect(WORKSPACE_HELPERS_SOURCE).toContain('export function getCanonicalWorkspaceId')
    expect(WORKSPACE_HELPERS_SOURCE).toContain('export function resolveWorkspaceCandidateForProjectPath')
    expect(PANEL_VIEW_SOURCE).toContain('export function useAppPanelViewMode')
    expect(PANEL_VIEW_SOURCE).toContain('enterTabbedView')
    expect(PANEL_VIEW_SOURCE).toContain('promoteExpandedTileToLayoutGroup')
    expect(CANVAS_VIEW_PROPS_SOURCE).toContain('export function useAppCanvasConnectionProps')
    expect(CANVAS_VIEW_PROPS_SOURCE).toContain('export function useAppCanvasPanelRegionProps')
  })
})
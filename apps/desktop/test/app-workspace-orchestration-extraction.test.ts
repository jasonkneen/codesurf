import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const ROOT_DIR = process.cwd()
const APP_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/App.tsx'), 'utf8')
const WORKSPACE_HOOK_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useAppWorkspaceOrchestration.ts'), 'utf8')
const CANVAS_LOAD_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/lib/canvasWorkspaceLoad.ts'), 'utf8')
const LAYOUT_LAUNCH_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/lib/layoutTemplateLaunch.ts'), 'utf8')

describe('wave 29 workspace orchestration extraction', () => {
  test('App delegates workspace switching and template launch to modules', () => {
    expect(APP_SOURCE).toContain("from './hooks/useAppWorkspaceOrchestration'")
    expect(APP_SOURCE).toContain('useAppWorkspaceOrchestration(')
    expect(APP_SOURCE).toContain('handleLaunchTemplate')
    expect(APP_SOURCE).not.toContain('const handleSwitchWorkspace = useCallback')
    expect(APP_SOURCE).not.toContain('const handleLaunchTemplate = useCallback')
    expect(APP_SOURCE).not.toContain('const showEmptyLayoutPage = useCallback')
    expect(APP_SOURCE).not.toContain('generateTiles(template.tree')
  })

  test('extracted modules own workspace and layout launch logic', () => {
    expect(WORKSPACE_HOOK_SOURCE).toContain('export function useAppWorkspaceOrchestration')
    expect(WORKSPACE_HOOK_SOURCE).toContain('handleSwitchWorkspace')
    expect(WORKSPACE_HOOK_SOURCE).toContain('handleLaunchTemplate')
    expect(WORKSPACE_HOOK_SOURCE).toContain('showEmptyLayoutPage')
    expect(CANVAS_LOAD_SOURCE).toContain('export function applySavedCanvasState')
    expect(LAYOUT_LAUNCH_SOURCE).toContain('export function generateLayoutFromTemplate')
    expect(LAYOUT_LAUNCH_SOURCE).toContain('tile-template-')
  })

  test('initial canvas hydration uses the same generation-guarded switch lane', () => {
    expect(APP_SOURCE).toContain('await handleSwitchWorkspaceRef.current(targetWorkspace.id)')
    expect(APP_SOURCE).not.toContain('window.electron.canvas.load(')
    expect(WORKSPACE_HOOK_SOURCE).toContain('LatestWorkspaceSwitchCoordinator')
    expect(WORKSPACE_HOOK_SOURCE).toContain('commitLatest(switchToken')
  })

  test('quit persistence forces the ordered final window to write even when clean', () => {
    expect(APP_SOURCE).toContain("force: request.reason === 'quit'")
  })

  test('picker and final-tab transitions flush before clearing authoritative refs', () => {
    expect(WORKSPACE_HOOK_SOURCE).toContain('transitionToWorkspacePicker({')
    expect(WORKSPACE_HOOK_SOURCE).toContain('flushOutgoing: flushPendingSave')
    expect(WORKSPACE_HOOK_SOURCE).toContain('await showEmptyLayoutPage()')
    expect(WORKSPACE_HOOK_SOURCE).toContain('commitWorkspaceCanvasOwnership(')
  })

  test('workspace ownership is explicit and mini-chat canvas persistence is disabled', () => {
    expect(APP_SOURCE).not.toContain(
      'useEffect(() => { currentWorkspaceIdRef.current = workspace?.id ?? null }',
    )
    expect(APP_SOURCE).toContain('resolveCanvasPersistenceMode(')
    expect(APP_SOURCE).toContain('Boolean(miniChatOptions)')
    expect(APP_SOURCE).toContain('miniChatOptions || !request.canvasOwner')
    expect(WORKSPACE_HOOK_SOURCE).toContain('transferCanvasWorkspaceOwnership')
    expect(WORKSPACE_HOOK_SOURCE).toContain('releaseWorkspacePersistence')
  })
})

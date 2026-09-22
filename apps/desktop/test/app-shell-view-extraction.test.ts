import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const ROOT_DIR = process.cwd()
const APP_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/App.tsx'), 'utf8')
const SIDEBAR_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/AppSidebarRegion.tsx'), 'utf8')
const TABBAR_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/AppWorkspaceTabBar.tsx'), 'utf8')
const OVERLAYS_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/AppOverlays.tsx'), 'utf8')

describe('wave 22 shell view extractions', () => {
  test('App delegates sidebar, workspace tabs, and overlays to shell components', () => {
    expect(APP_SOURCE).toContain("from './components/AppSidebarRegion'")
    expect(APP_SOURCE).toContain("from './components/AppWorkspaceTabBar'")
    expect(APP_SOURCE).toContain("from './components/AppOverlays'")
    expect(APP_SOURCE).toContain('<AppSidebarRegion')
    expect(APP_SOURCE).toContain('<AppWorkspaceTabBar')
    expect(APP_SOURCE).toContain('<AppOverlays')
    expect(APP_SOURCE).not.toContain('<LazySidebar')
    expect(APP_SOURCE).not.toContain('cs-mini-chat-window')
    expect(APP_SOURCE).not.toContain('function WorkspaceTabIcon')
    expect(APP_SOURCE).not.toContain('<DevSandboxFrame />')
  })

  test('shell components own extracted JSX regions', () => {
    expect(SIDEBAR_SOURCE).toContain('LazySidebar')
    expect(SIDEBAR_SOURCE).toContain('LazySidebarFooter')
    expect(SIDEBAR_SOURCE).toContain('MainStatusBar')
    expect(TABBAR_SOURCE).toContain('WorkspaceTabIcon')
    expect(TABBAR_SOURCE).toContain('openWorkspaceTabs.map')
    expect(TABBAR_SOURCE).toContain('<WorkspaceTabLabel active>Workspace</WorkspaceTabLabel>')
    expect(TABBAR_SOURCE).not.toContain('WORKSPACE')
    expect(OVERLAYS_SOURCE).toContain('LazyCommandPalette')
    expect(OVERLAYS_SOURCE).toContain('DevSandboxFrame')
  })
})
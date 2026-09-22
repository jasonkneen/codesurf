import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const ROOT_DIR = process.cwd()
const APP_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/App.tsx'), 'utf8')
const SCROLL_FADE_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useScrollFadeIndicators.ts'), 'utf8')
const SHELL_LAYOUT_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useShellLayoutMetrics.ts'), 'utf8')
const SHELL_CHROME_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useAppShellChrome.ts'), 'utf8')

describe('wave 20 shell layout extractions', () => {
  test('App delegates scroll-fade tracking to useScrollFadeIndicators', () => {
    expect(APP_SOURCE).toContain("from './hooks/useScrollFadeIndicators'")
    expect(APP_SOURCE).toContain('useScrollFadeIndicators()')
    expect(APP_SOURCE).not.toContain('data-scroll-fade-active')
  })

  test('scroll-fade hook owns mutation and resize observers', () => {
    expect(SCROLL_FADE_SOURCE).toContain('data-scroll-fade-active')
    expect(SCROLL_FADE_SOURCE).toContain('MutationObserver')
    expect(SCROLL_FADE_SOURCE).toContain('ResizeObserver')
  })

  test('App delegates shell layout metrics to useShellLayoutMetrics', () => {
    expect(APP_SOURCE).toContain("from './hooks/useAppShellChrome'")
    expect(APP_SOURCE).toContain('useAppShellChrome({')
    expect(SHELL_CHROME_SOURCE).toContain("from './useShellLayoutMetrics'")
    expect(SHELL_CHROME_SOURCE).toContain('useShellLayoutMetrics({')
    expect(APP_SOURCE).not.toContain('const mainPanelInsetEdgeShadow = theme.mode')
    expect(APP_SOURCE).not.toContain('function withAlpha(color: string, alpha: number)')
  })

  test('shell layout hook owns panel chrome and workspace tab metrics', () => {
    expect(SHELL_LAYOUT_SOURCE).toContain('mainPanelInsetEdgeShadow')
    expect(SHELL_LAYOUT_SOURCE).toContain('workspaceTabInactiveBackground')
    expect(SHELL_LAYOUT_SOURCE).toContain('openWorkspaceTabs')
    expect(SHELL_LAYOUT_SOURCE).toContain('dsc')
  })
})

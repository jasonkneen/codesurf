import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const ROOT_DIR = process.cwd()
const APP_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/App.tsx'), 'utf8')
const SHELL_CHROME_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useAppShellChrome.ts'), 'utf8')
const HOOK_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useAppThemeCssVars.ts'), 'utf8')

describe('useAppThemeCssVars extraction', () => {
  test('App delegates theme CSS variable publishing to the hook', () => {
    expect(APP_SOURCE).toContain("from './hooks/useAppShellChrome'")
    expect(APP_SOURCE).toContain('useAppShellChrome(')
    expect(SHELL_CHROME_SOURCE).toContain("from './useAppThemeCssVars'")
    expect(SHELL_CHROME_SOURCE).toContain('useAppThemeCssVars(theme, appFonts)')
    expect(APP_SOURCE).not.toContain("setVar('--cs-th-app'")
    expect(APP_SOURCE).not.toContain("root.style.setProperty('--color-background'")
    expect(APP_SOURCE).not.toContain("root.style.setProperty('--ct-font-primary'")
  })

  test('hook owns theme token and font CSS custom property effects', () => {
    expect(HOOK_SOURCE).toContain("setVar('--cs-th-app'")
    expect(HOOK_SOURCE).toContain("root.style.setProperty('--color-background'")
    expect(HOOK_SOURCE).toContain("root.style.setProperty('--ct-font-primary'")
    expect(HOOK_SOURCE).toContain("root.style.setProperty('--cs-font-primary'")
    expect(HOOK_SOURCE).toContain("root.style.setProperty('--cs-font-secondary'")
    expect(HOOK_SOURCE).toContain('getEdgeShadow(theme')
    expect(HOOK_SOURCE).toContain('--cs-th-scrollbar-thumb')
  })
})

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const ROOT = process.cwd()

describe('app font tokens', () => {
  test('html/body use the primary token so settings actually cascade', () => {
    const css = readFileSync(join(ROOT, 'src/renderer/src/index.css'), 'utf8')
    const hook = readFileSync(join(ROOT, 'src/renderer/src/hooks/useAppThemeCssVars.ts'), 'utf8')
    const layout = readFileSync(join(ROOT, 'src/renderer/src/components/chat/chatTileLayout.ts'), 'utf8')
    const bridge = readFileSync(join(ROOT, 'src/main/extensions/bridge.ts'), 'utf8')
    expect(css).toContain('font-family: var(--cs-font-primary)')
    expect(hook).toContain("root.style.setProperty('--cs-font-primary', appFonts.primary)")
    expect(hook).toContain("root.style.setProperty('--cs-font-secondary', appFonts.secondary)")
    expect(layout).toContain('DEFAULT_FONTS.primary.family')
    expect(bridge).toContain('font-family:var(--ct-font-primary,var(--ct-font-sans,sans-serif))')
  })
})

describe('Bricolage Grotesque is the default primary + secondary face', () => {
  // This is a product decision, not an incidental default. It has been lost
  // once already to a font-token refactor, so it is pinned here.
  test('DEFAULT_FONTS.primary and .secondary lead with Bricolage Grotesque', async () => {
    const { DEFAULT_FONTS } = await import('../src/shared/settings-runtime.ts')
    expect(DEFAULT_FONTS.primary.family.startsWith('"Bricolage Grotesque"')).toBe(true)
    expect(DEFAULT_FONTS.secondary.family.startsWith('"Bricolage Grotesque"')).toBe(true)
  })

  test('is bundled, declared via @font-face, and offered in the picker', () => {
    const controls = readFileSync(join(ROOT, 'src/renderer/src/components/settings/controls.tsx'), 'utf8')
    const css = readFileSync(join(ROOT, 'src/renderer/src/index.css'), 'utf8')
    expect(controls).toContain('"Bricolage Grotesque"')
    expect(css).toContain("font-family: 'Bricolage Grotesque'")
    expect(
      existsSync(join(ROOT, 'src/renderer/src/assets/fonts/BricolageGrotesque-VariableFont_opsz,wdth,wght.ttf')),
    ).toBe(true)
  })

  test('the @font-face points at the bundled file, so it renders offline', () => {
    const css = readFileSync(join(ROOT, 'src/renderer/src/index.css'), 'utf8')
    expect(css).toContain("url('./assets/fonts/BricolageGrotesque-VariableFont_opsz,wdth,wght.ttf')")
  })
})

describe('Manrope UI font', () => {
  test('is available for primary and secondary font pickers and is bundled', () => {
    const controls = readFileSync(join(ROOT, 'src/renderer/src/components/settings/controls.tsx'), 'utf8')
    const css = readFileSync(join(ROOT, 'src/renderer/src/index.css'), 'utf8')
    expect(controls).toContain('"Manrope"')
    expect(css).toContain("font-family: 'Manrope'")
    expect(existsSync(join(ROOT, 'src/renderer/src/assets/fonts/Manrope-VariableFont_wght.ttf'))).toBe(true)
  })
})

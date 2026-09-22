import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

describe('themePresets catalog split', () => {
  test('core, dark, and light modules exist', () => {
    assert.equal(existsSync(join(root, 'src/renderer/src/themePresetsCore.ts')), true)
    assert.equal(existsSync(join(root, 'src/renderer/src/themePresetsDark.ts')), true)
    assert.equal(existsSync(join(root, 'src/renderer/src/themePresetsLight.ts')), true)
  })

  test('public themePresets merges dark + light and re-exports builders', () => {
    const main = read('src/renderer/src/themePresets.ts')
    assert.match(main, /THEME_ENTRIES_DARK/)
    assert.match(main, /THEME_ENTRIES_LIGHT/)
    assert.match(main, /export const THEMES/)
    assert.match(main, /normalizePanelSurfaceTheme/)
    assert.match(main, /getEdgeShadow/)
  })

  test('catalogs are mode-focused and core holds builders not THEMES map', () => {
    const core = read('src/renderer/src/themePresetsCore.ts')
    assert.equal(/const THEMES/.test(core), false)
    assert.match(core, /export function getEdgeShadow/)
    assert.match(core, /export function defineTheme/)

    const dark = read('src/renderer/src/themePresetsDark.ts')
    const light = read('src/renderer/src/themePresetsLight.ts')
    assert.match(dark, /default-dark|warm-graphite|forest-dark/)
    assert.match(light, /paper-light|warm-light|linen-light/)
    assert.equal(dark.includes('paper-light'), false)
    assert.equal(light.includes('default-dark'), false)
  })

  test('theme.ts still imports public THEMES surface', () => {
    const theme = read('src/renderer/src/theme.ts')
    assert.match(theme, /from ['\"]\.\/themePresets['\"]/)
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const ROOT_DIR = process.cwd()
const THEME_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/themePresetsCore.ts'), 'utf8')
const INDEX_CSS = readFileSync(join(ROOT_DIR, 'src/renderer/src/index.css'), 'utf8')

describe('theme edge shadow hierarchy', () => {
  test('dark mode uses a single light outer keyline in getEdgeShadow', () => {
    expect(THEME_SOURCE).toContain("if (theme.mode === 'dark')")
    expect(THEME_SOURCE).toContain('0 0 0 0.5px rgba(255, 255, 255')
  })

  test('light mode keeps inset highlight plus darker outer keyline', () => {
    expect(THEME_SOURCE).toContain('inset 0 0 0 0.5px rgba(255, 255, 255')
    expect(THEME_SOURCE).toContain('0 0 0 0.5px rgba(0, 0, 0')
  })

  test('CSS vars support light outer keyline channel in dark mode', () => {
    expect(INDEX_CSS).toContain('--cs-th-edge-outer-rgb: 255 255 255')
    expect(INDEX_CSS).toContain('rgb(var(--cs-th-edge-outer-rgb)')
  })
})

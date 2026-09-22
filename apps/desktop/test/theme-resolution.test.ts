import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveThemeIdForAppearance } from '../src/renderer/src/themeResolution.ts'

const defaultDarkThemeId = 'default-dark'
const defaultLightThemeId = 'paper-light'

test('dark appearance falls back from a saved light theme to the dark default', () => {
  assert.equal(resolveThemeIdForAppearance('dark', 'paper-light', 'light', false, defaultDarkThemeId, defaultLightThemeId), defaultDarkThemeId)
  assert.equal(resolveThemeIdForAppearance('dark', 'paper-light', 'light', true, defaultDarkThemeId, defaultLightThemeId), defaultDarkThemeId)
})

test('system appearance resolves to the OS-matching theme family', () => {
  assert.equal(resolveThemeIdForAppearance('system', 'paper-light', 'light', false, defaultDarkThemeId, defaultLightThemeId), defaultLightThemeId)
  assert.equal(resolveThemeIdForAppearance('system', 'paper-light', 'light', true, defaultDarkThemeId, defaultLightThemeId), defaultDarkThemeId)
})

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  applyGuestWebviewWebPreferences,
  createMainWindowWebPreferences,
  formatGuestWebviewTagPreferences,
  GUEST_WEBVIEW_WEB_PREFERENCES,
} from '../src/main/secure-web-preferences.ts'

describe('secure-web-preferences', () => {
  test('main window keeps sandbox:false with context isolation', () => {
    const prefs = createMainWindowWebPreferences('/tmp/preload.js')
    assert.equal(prefs.sandbox, false)
    assert.equal(prefs.contextIsolation, true)
    assert.equal(prefs.nodeIntegration, false)
    assert.equal(prefs.webviewTag, true)
    assert.equal(prefs.preload, '/tmp/preload.js')
  })

  test('guest webview tag preferences enforce sandbox and isolation', () => {
    const formatted = formatGuestWebviewTagPreferences({ backgroundColor: '#111317', devTools: true })
    assert.match(formatted, /sandbox=yes/)
    assert.match(formatted, /contextIsolation=yes/)
    assert.match(formatted, /nodeIntegration=no/)
    assert.match(formatted, /backgroundColor=#111317/)
    assert.match(formatted, /devTools=yes/)
  })

  test('applyGuestWebviewWebPreferences strips preload and enables sandbox', () => {
    const prefs = {
      preload: '/evil/preload.js',
      sandbox: false,
      contextIsolation: false,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      webSecurity: false,
      allowRunningInsecureContent: true,
    }
    applyGuestWebviewWebPreferences(prefs)
    assert.equal(prefs.preload, undefined)
    assert.deepEqual(
      {
        sandbox: prefs.sandbox,
        contextIsolation: prefs.contextIsolation,
        nodeIntegration: prefs.nodeIntegration,
        nodeIntegrationInSubFrames: prefs.nodeIntegrationInSubFrames,
        webSecurity: prefs.webSecurity,
        allowRunningInsecureContent: prefs.allowRunningInsecureContent,
      },
      GUEST_WEBVIEW_WEB_PREFERENCES,
    )
  })
})
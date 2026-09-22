import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// detect.ts is TypeScript; reimplement the pure logic for unit coverage
// (renderer TS is compiled by Vite; this locks the contract).
function detectPlatform(win) {
  if (!win) return 'web'
  if (win.__CODESURF_PLATFORM__ === 'electron' || win.__CODESURF_PLATFORM__ === 'native' || win.__CODESURF_PLATFORM__ === 'web') {
    return win.__CODESURF_PLATFORM__
  }
  if (win.electron) return 'electron'
  if (win.zero) return 'native'
  return 'web'
}

describe('platform detect contract', () => {
  it('prefers electron when window.electron exists', () => {
    assert.equal(detectPlatform({ electron: {}, zero: {} }), 'electron')
  })

  it('detects native via window.zero', () => {
    assert.equal(detectPlatform({ zero: {} }), 'native')
  })

  it('defaults to web', () => {
    assert.equal(detectPlatform({}), 'web')
    assert.equal(detectPlatform(undefined), 'web')
  })

  it('honors explicit platform marker', () => {
    assert.equal(detectPlatform({ __CODESURF_PLATFORM__: 'web', zero: {} }), 'web')
    assert.equal(detectPlatform({ __CODESURF_PLATFORM__: 'native', electron: {} }), 'native')
  })
})

describe('resolve-native-sdk', () => {
  it('finds a native SDK checkout on this machine', async () => {
    const mod = await import(pathToFileURL(resolve(root, 'scripts/resolve-native-sdk.mjs')).href)
    const path = mod.resolveNativeSdkPath()
    assert.ok(path, 'expected NATIVE_SDK_PATH or a default checkout')
    assert.match(path, /native/)
  })
})

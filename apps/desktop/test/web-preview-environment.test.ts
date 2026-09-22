import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildIsolatedWebPreviewEnv } from '../e2e/helpers/web-preview-env.ts'

test('built-web preview environment discards inherited CodeSurf runtime state', () => {
  const inherited = {
    PATH: '/fixture/bin',
    CI: 'true',
    HOME: '/host/home',
    UserProfile: 'C:\\Users\\host',
    CODESURF_HOME: '/host/.codesurf',
    codesurf_web_host_url: 'http://host-runtime.invalid',
    CODESURF_TERMINAL_TOKEN: 'host-terminal-secret',
    CODESURF_UNRELATED_FUTURE_SETTING: 'host-state',
  }
  const env = buildIsolatedWebPreviewEnv(
    inherited,
    {
      homeDir: '/isolated/home',
      codesurfHome: '/isolated/home/.codesurf',
      hostUrl: 'http://127.0.0.1:41001',
      hostPort: 41001,
      hostToken: 'isolated-host-token',
      previewPort: 41002,
      runtimeConfigPort: 41003,
      terminalPort: 41004,
      terminalToken: 'isolated-terminal-token',
    },
  )

  assert.equal(env.PATH, '/fixture/bin')
  assert.equal(env.CI, 'true')
  assert.equal(env.HOME, '/isolated/home')
  assert.equal(env.USERPROFILE, '/isolated/home')
  assert.equal(env.UserProfile, undefined)
  assert.equal(env.codesurf_web_host_url, undefined)
  assert.equal(env.CODESURF_UNRELATED_FUTURE_SETTING, undefined)
  assert.equal(env.CODESURF_HOME, '/isolated/home/.codesurf')
  assert.equal(env.CODESURF_WEB_HOST_URL, 'http://127.0.0.1:41001')
  assert.equal(env.CODESURF_WEB_HOST_PORT, '41001')
  assert.equal(env.CODESURF_WEB_HOST_TOKEN, 'isolated-host-token')
  assert.equal(env.CODESURF_WEB_PREVIEW_PORT, '41002')
  assert.equal(env.CODESURF_WEB_PREVIEW_RUNTIME_PORT, '41003')
  assert.equal(env.CODESURF_WEB_PREVIEW_TERMINAL_PORT, '41004')
  assert.equal(env.CODESURF_TERMINAL_TOKEN, 'isolated-terminal-token')
  assert.equal(inherited.HOME, '/host/home')
  assert.equal(inherited.CODESURF_TERMINAL_TOKEN, 'host-terminal-secret')
})

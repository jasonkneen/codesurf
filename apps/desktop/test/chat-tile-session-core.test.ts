/**
 * Structural tests: ChatTile session core + stream hub wiring.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

describe('ChatTile session core + stream demux wiring', () => {
  test('useChatTileSessionCore composes core, stream buffer, hub handler, transcript', () => {
    const src = read('src/renderer/src/hooks/useChatTileSessionCore.ts')
    assert.match(src, /useChatTileCoreState/)
    assert.match(src, /useChatTileStreamBuffer/)
    assert.match(src, /useChatStreamHandler/)
    assert.match(src, /useChatTileTranscript/)
    assert.match(src, /commitSessionId/)
  })

  test('useChatStreamHandler uses subscribeChatStream demux (not raw onChunk)', () => {
    const src = read('src/renderer/src/hooks/useChatStreamHandler.ts')
    assert.match(src, /subscribeChatStream/)
    assert.equal(/stream\?\.onChunk|stream\.onChunk/.test(src), false)
  })

  test('ChatTile consumes session core + shell model + send path (not domain-hook forest)', () => {
    const src = read('src/renderer/src/components/ChatTile.tsx')
    assert.match(src, /useChatTileSessionCore/)
    assert.match(src, /useChatTileShellModel/)
    assert.match(src, /useChatTileSendPath/)
    // Domain hooks moved into orchestration units
    assert.equal(/useChatStreamHandler\(/.test(src), false)
    assert.equal(/useChatTileCoreState\(/.test(src), false)
    assert.equal(/useChatTileTranscript\(/.test(src), false)
    assert.equal(/useChatTileStreamBuffer\(/.test(src), false)
    assert.equal(/useChatTileProviders\(/.test(src), false)
    assert.equal(/useChatTileLifecycleEffects\(/.test(src), false)
    assert.equal(/useChatTileComposerMenus\(/.test(src), false)
    assert.equal(/useChatTileAgentModes\(/.test(src), false)
    assert.equal(/useChatTileMessaging\(/.test(src), false)
    assert.equal(/useChatTileAttachments\(/.test(src), false)
  })

  test('useChatTileSendPath owns messaging/attachments/keys composition', () => {
    const src = read('src/renderer/src/hooks/useChatTileSendPath.ts')
    assert.match(src, /useChatTileMessaging/)
    assert.match(src, /useChatTileAttachments/)
    assert.match(src, /useChatTileComposerKeys/)
  })

  test('useChatTileShellModel owns remaining non-session domain orchestration', () => {
    const src = read('src/renderer/src/hooks/useChatTileShellModel.ts')
    assert.match(src, /export function useChatTileShellModel/)
    assert.match(src, /useChatTileProviders/)
    assert.match(src, /useChatTileLifecycleEffects/)
    assert.match(src, /useChatTileComposerMenus/)
  })

  test('chatStreamHub exports demux API used by production path', () => {
    const src = read('src/renderer/src/components/chat/chatStreamHub.ts')
    assert.match(src, /export function subscribeChatStream/)
    assert.match(src, /listenersByScope/)
    assert.match(src, /ensureTransport/)
  })

  test('StreamingLivenessIndicator uses shared thinking clock (no per-chip setInterval)', () => {
    const src = read('src/renderer/src/components/chat/ThinkingWorkingChips.tsx')
    assert.match(src, /StreamingLivenessIndicator[\s\S]*useSharedThinkingClock\(true\)/)
    // No setInterval left in this module for chip timers
    assert.equal(/setInterval\(/.test(src), false)
  })

  test('App shell chrome composition lives in useAppShellChrome', () => {
    const app = read('src/renderer/src/App.tsx')
    assert.match(app, /useAppShellChrome/)
    assert.equal(/useShellLayoutMetrics\(/.test(app), false)
    const chrome = read('src/renderer/src/hooks/useAppShellChrome.ts')
    assert.match(chrome, /useShellLayoutMetrics/)
    assert.match(chrome, /useAppThemeCssVars/)
  })
})

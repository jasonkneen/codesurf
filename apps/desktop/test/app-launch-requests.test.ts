import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  CODESURF_CREATE_TILE_EVENT,
  CODESURF_OPEN_CHAT_SURFACE_EVENT,
  normalizeCreateTileDetail,
  normalizeOpenChatSurfaceDetail,
  resolveChatSurfaceTargetTile,
} from '../src/renderer/src/utils/appLaunchRequests.ts'

const ROOT_DIR = process.cwd()

describe('app launch requests', () => {
  test('normalizes create-tile requests for core and extension tiles', () => {
    expect(CODESURF_CREATE_TILE_EVENT).toBe('codesurf:create-tile')
    expect(normalizeCreateTileDetail({ type: 'ext:qa-workbench', x: 12, y: 24, sourceTileId: 'browser-1' })).toEqual({
      type: 'ext:qa-workbench',
      x: 12,
      y: 24,
      focus: true,
      sourceTileId: 'browser-1',
    })
    expect(normalizeCreateTileDetail({ type: 'chat', focus: false })).toEqual({
      type: 'chat',
      focus: false,
    })
    expect(normalizeCreateTileDetail({ x: 1 })).toBeNull()
  })

  test('normalizes chat-surface launch requests and rejects incomplete targets', () => {
    expect(CODESURF_OPEN_CHAT_SURFACE_EVENT).toBe('codesurf:open-chat-surface')
    expect(normalizeOpenChatSurfaceDetail({ extId: 'qa-workbench', surfaceId: 'qa-report', sourceTileId: 'browser-1', initialContext: { 'ctx:qa-workbench:report': 'r' } })).toEqual({
      extId: 'qa-workbench',
      surfaceId: 'qa-report',
      sourceTileId: 'browser-1',
      initialContext: { 'ctx:qa-workbench:report': 'r' },
    })
    expect(normalizeOpenChatSurfaceDetail({ extId: 'qa-workbench', id: 'qa-report', targetTileId: 'chat-1' })).toEqual({
      extId: 'qa-workbench',
      surfaceId: 'qa-report',
      targetTileId: 'chat-1',
    })
    expect(normalizeOpenChatSurfaceDetail({ extId: 'qa-workbench' })).toBeNull()
  })

  test('resolves chat-surface requests to targeted, active, existing, or new chat tiles', () => {
    const tiles = [
      { id: 'browser-1', type: 'browser' },
      { id: 'chat-1', type: 'chat' },
      { id: 'chat-2', type: 'chat' },
    ]

    expect(resolveChatSurfaceTargetTile({ tiles, targetTileId: 'chat-2', activeChatTileId: 'chat-1' })).toEqual({
      tileId: 'chat-2',
      shouldCreate: false,
      reason: 'target',
    })
    expect(resolveChatSurfaceTargetTile({ tiles, targetTileId: 'browser-1', activeChatTileId: 'chat-1' })).toEqual({
      tileId: 'chat-1',
      shouldCreate: false,
      reason: 'active',
    })
    expect(resolveChatSurfaceTargetTile({ tiles, activeChatTileId: null })).toEqual({
      tileId: 'chat-1',
      shouldCreate: false,
      reason: 'existing',
    })
    expect(resolveChatSurfaceTargetTile({ tiles: [{ id: 'browser-1', type: 'browser' }], activeChatTileId: null })).toEqual({
      tileId: null,
      shouldCreate: true,
      reason: 'create',
    })
  })

  test('extension tile bridge exposes openSurface and dispatches through the host event', () => {
    const bridgeSource = readFileSync(join(ROOT_DIR, 'src/main/extensions/bridge.ts'), 'utf8')
    const tileHostSource = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/ExtensionTile.tsx'), 'utf8')
    const chatHostSource = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/ChatTile.tsx'), 'utf8')
    const chatShellModelSource = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useChatTileShellModel.ts'), 'utf8')
    const chatSurfacesHookSource = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useChatTileSurfaces.ts'), 'utf8')

    expect(bridgeSource).toContain('openSurface')
    expect(bridgeSource).toContain("_rpc('chat.openSurface'")
    expect(tileHostSource).toContain("case 'chat.openSurface'")
    expect(tileHostSource).toContain('CODESURF_OPEN_CHAT_SURFACE_EVENT')
    expect(chatHostSource).toContain('useChatTileShellModel')
    expect(chatShellModelSource).toContain('useChatTileSurfaces')
    expect(chatSurfacesHookSource).toContain('handleOpenChatSurfaceRequest')
    expect(chatSurfacesHookSource).toContain('normalizeOpenChatSurfaceDetail')
  })
})

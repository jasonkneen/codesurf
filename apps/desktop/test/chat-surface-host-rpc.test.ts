import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  buildChatSurfaceMeta,
  handleBasicChatSurfaceRpc,
  normalizeChatSurfacePayload,
} from '../src/renderer/src/components/chatSurfaceHostRpc.ts'

const surface = {
  extId: 'rewind-lite',
  surfaceId: 'rewind-digest',
  label: 'Rewind Digest',
  instanceId: 'surf-123',
}

describe('chatSurfaceHostRpc', () => {
  test('normalizeChatSurfacePayload keeps supported fields and coerces kind', () => {
    expect(normalizeChatSurfacePayload({ kind: 'text', data: 'hello', mime: 'text/plain', ext: 'txt' })).toEqual({
      kind: 'text',
      data: 'hello',
      mime: 'text/plain',
      ext: 'txt',
    })

    expect(normalizeChatSurfacePayload({ kind: 'unknown', data: 'abc' })).toEqual({
      kind: 'image',
      data: 'abc',
      mime: undefined,
      ext: undefined,
    })

    expect(normalizeChatSurfacePayload(null)).toBeNull()
  })

  test('buildChatSurfaceMeta includes workspace information and peer ids', () => {
    expect(buildChatSurfaceMeta(surface, ['peer-a', 'peer-b'], 'ws-1', '/tmp/demo')).toEqual({
      tileId: 'surf-123',
      extId: 'rewind-lite',
      surfaceId: 'rewind-digest',
      kind: 'chat-surface',
      connectedPeers: ['peer-a', 'peer-b'],
      workspaceId: 'ws-1',
      workspacePath: '/tmp/demo',
    })
  })

  test('handleBasicChatSurfaceRpc proxies settings and extension invocation', async () => {
    const calls: Array<{ type: string; payload: unknown }> = []
    const result = await handleBasicChatSurfaceRpc({
      method: 'ext.invoke',
      params: { method: 'digest', args: ['a', 'b'] },
      surface,
      connectedPeerIds: ['peer-a'],
      workspaceId: 'ws-1',
      workspacePath: '/tmp/demo',
      themeColors: { accent: '#fff' },
      extensionsApi: {
        invoke: async (extId, method, ...args) => {
          calls.push({ type: 'invoke', payload: { extId, method, args } })
          return { ok: true, extId, method, args }
        },
        getSettings: async (extId) => {
          calls.push({ type: 'getSettings', payload: extId })
          return { commitLimit: 7 }
        },
        setSettings: async (extId, settings) => {
          calls.push({ type: 'setSettings', payload: { extId, settings } })
          return true
        },
      },
    })

    expect(result).toEqual({
      handled: true,
      result: { ok: true, extId: 'rewind-lite', method: 'digest', args: ['a', 'b'] },
    })

    const settingsResult = await handleBasicChatSurfaceRpc({
      method: 'settings.get',
      params: { key: 'commitLimit' },
      surface,
      connectedPeerIds: [],
      workspaceId: 'ws-1',
      workspacePath: '/tmp/demo',
      themeColors: {},
      extensionsApi: {
        getSettings: async () => ({ commitLimit: 7 }),
      },
    })

    expect(settingsResult).toEqual({ handled: true, result: 7 })

    const setResult = await handleBasicChatSurfaceRpc({
      method: 'settings.set',
      params: { commitLimit: 9 },
      surface,
      connectedPeerIds: [],
      workspaceId: 'ws-1',
      workspacePath: '/tmp/demo',
      themeColors: {},
      extensionsApi: {
        setSettings: async (extId, settings) => {
          calls.push({ type: 'setSettings', payload: { extId, settings } })
          return true
        },
      },
    })

    expect(setResult).toEqual({ handled: true, result: true })
    expect(calls).toContainEqual({
      type: 'invoke',
      payload: { extId: 'rewind-lite', method: 'digest', args: ['a', 'b'] },
    })
    expect(calls).toContainEqual({
      type: 'setSettings',
      payload: { extId: 'rewind-lite', settings: { commitLimit: 9 } },
    })
  })

  test('handleBasicChatSurfaceRpc can request another chat surface from inside a chat surface', async () => {
    const requests: unknown[] = []
    const result = await handleBasicChatSurfaceRpc({
      method: 'chat.openSurface',
      params: { request: { extId: 'qa-workbench', surfaceId: 'qa-report', preferredTileId: 'chat-1', initialContext: { 'ctx:qa-workbench:report': 'r' } } },
      surface,
      connectedPeerIds: [],
      workspaceId: 'ws-1',
      workspacePath: '/tmp/demo',
      themeColors: {},
      extensionsApi: {},
      openChatSurface: async (request) => {
        requests.push(request)
        return true
      },
    })

    expect(result).toEqual({ handled: true, result: true })
    expect(requests).toEqual([{ extId: 'qa-workbench', surfaceId: 'qa-report', preferredTileId: 'chat-1', sourceTileId: 'surf-123', initialContext: { 'ctx:qa-workbench:report': 'r' } }])
  })

  test('handleBasicChatSurfaceRpc returns normalized payload and workspace path', async () => {
    const payloadResult = await handleBasicChatSurfaceRpc({
      method: 'surface.setPayload',
      params: { payload: { kind: 'text', data: '# digest', mime: 'text/markdown', ext: 'md' } },
      surface,
      connectedPeerIds: [],
      workspaceId: 'ws-1',
      workspacePath: '/tmp/demo',
      themeColors: {},
      extensionsApi: {},
    })

    expect(payloadResult).toEqual({
      handled: true,
      result: true,
      payload: { kind: 'text', data: '# digest', mime: 'text/markdown', ext: 'md' },
    })

    const pathResult = await handleBasicChatSurfaceRpc({
      method: 'workspace.getPath',
      params: {},
      surface,
      connectedPeerIds: [],
      workspaceId: 'ws-1',
      workspacePath: '/tmp/demo',
      themeColors: {},
      extensionsApi: {},
    })

    expect(pathResult).toEqual({ handled: true, result: '/tmp/demo' })
  })
})

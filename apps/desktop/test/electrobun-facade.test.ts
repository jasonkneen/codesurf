import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { expect } from './node-expect.ts'
import {
  createHostBackedElectrobunElectronFacade,
  createElectrobunElectronFacade,
  createElectrobunEventHub,
  getDefaultElectrobunInvokeResponse,
  invokeElectrobunWithFallback,
  withElectrobunHostBootstrap,
  type ElectrobunInvokeCall,
} from '../src/electrobun/browser/electron-facade.ts'

describe('Electrobun window.electron facade', () => {
  test('bootstraps the synchronous homedir field from the authoritative host', async () => {
    const calls: ElectrobunInvokeCall[] = []
    const facade = createHostBackedElectrobunElectronFacade({
      platform: 'darwin',
      hostHomedir: '/host-owned/home',
      invoke: async (channel, args) => {
        calls.push({ channel, args })
        return true
      },
    })

    expect(facade.homedir).toBe('/host-owned/home')
    expect(calls).toEqual([])
  })

  test('fails bridge bootstrap when the host cannot provide a home directory', async () => {
    assert.throws(
      () => createHostBackedElectrobunElectronFacade({
        platform: 'darwin',
        bootstrapUrl: 'views://mainview/index.html',
        invoke: async () => '',
      }),
      /valid home directory/,
    )
  })

  test('maps startup-critical facade methods to existing Electron IPC channel names', async () => {
    const calls: ElectrobunInvokeCall[] = []
    const facade = createElectrobunElectronFacade({
      platform: 'darwin',
      homedir: '/Users/tester',
      invoke: async (channel, args) => {
        calls.push({ channel, args })
        return true
      },
    })
    expect(facade.__codesurfHostKind).toBe('electrobun')

    await facade.workspace.list()
    await facade.settings.get()
    await facade.window.isFresh()
    await facade.shell.openExternal('https://example.com')
    await facade.canvas.queuedMessages.append({ id: 'msg-1' })
    await facade.terminal.updatePeers('tile-1', 'workspace-1', '/tmp/project', [])
    await facade.fs.readFile('/tmp/project/README.md', 'ws-1')
    await facade.fs.readFilePrefix('/tmp/project/README.md', 4096, 'ws-1')
    await facade.fs.watch('/tmp/project', () => {}, 'ws-1')()
    await new Promise(resolve => setImmediate(resolve))

    expect(calls).toEqual([
      { channel: 'workspace:list', args: [] },
      { channel: 'settings:get', args: [] },
      { channel: 'window:isFresh', args: [] },
      { channel: 'shell:openExternal', args: ['https://example.com'] },
      { channel: 'canvas:queuedMessages:append', args: [{ id: 'msg-1' }] },
      {
        channel: 'terminal:update-peers',
        args: ['tile-1', 'workspace-1', '/tmp/project', []],
      },
      { channel: 'fs:readFile', args: ['/tmp/project/README.md', 'ws-1'] },
      { channel: 'fs:readFilePrefix', args: ['/tmp/project/README.md', 4096, 'ws-1'] },
      { channel: 'fs:watchStart', args: ['/tmp/project', 'ws-1'] },
      { channel: 'fs:watchStop', args: ['/tmp/project', 'ws-1'] },
    ])
  })

  test('keeps the shared terminal create contract for provider CLI resume', async () => {
    const calls: ElectrobunInvokeCall[] = []
    const facade = createElectrobunElectronFacade({
      platform: 'darwin',
      homedir: '/Users/tester',
      invoke: async (channel, args) => {
        calls.push({ channel, args })
        return { cols: 80, rows: 24, buffer: '' }
      },
    })

    await facade.terminal.create(
      'chat-1-terminal',
      'workspace-1',
      '/tmp/project',
      'claude',
      ['--resume', 'session-1'],
      { cols: 100, rows: 30 },
    )

    assert.deepEqual(calls, [{
      channel: 'terminal:create',
      args: [
        'chat-1-terminal',
        'workspace-1',
        '/tmp/project',
        'claude',
        ['--resume', 'session-1'],
        { cols: 100, rows: 30 },
      ],
    }])
  })

  test('dispatches one-way runtime events to subscribed preload-style callbacks', () => {
    const hub = createElectrobunEventHub()
    const seen: unknown[] = []
    const cleanup = hub.on('bus:event', payload => seen.push(payload))

    hub.emit('bus:event', { channel: 'themes', payload: { mode: 'dark' } })
    cleanup()
    hub.emit('bus:event', { channel: 'themes', payload: { mode: 'light' } })

    expect(seen).toEqual([{ channel: 'themes', payload: { mode: 'dark' } }])
  })

  test('preserves workspace-scoped tile context arguments and Electron change payloads', async () => {
    const calls: ElectrobunInvokeCall[] = []
    const hub = createElectrobunEventHub()
    const facade = createElectrobunElectronFacade({
      platform: 'darwin',
      homedir: '/Users/tester',
      eventHub: hub,
      invoke: async (channel, args) => {
        calls.push({ channel, args })
        return true
      },
    })
    const changed: unknown[] = []
    const cleanup = facade.tileContext.onChanged('workspace-a', 'same-tile', (payload: unknown) => changed.push(payload))

    await facade.tileContext.get('workspace-a', 'same-tile', 'ctx:test')
    await facade.tileContext.getAll('workspace-a', 'same-tile', 'ctx:')
    await facade.tileContext.set('workspace-a', 'same-tile', 'ctx:test', 'value-a')
    await facade.tileContext.delete('workspace-a', 'same-tile', 'ctx:test')
    hub.emit('tileContext:changed', {
      workspaceId: 'workspace-a',
      tileId: 'same-tile',
      key: 'ctx:test',
      value: 'value-a',
    })
    hub.emit('tileContext:changed', {
      workspaceId: 'workspace-b',
      tileId: 'same-tile',
      key: 'ctx:test',
      value: 'wrong-workspace',
    })
    hub.emit('tileContext:changed', {
      workspaceId: 'workspace-a',
      tileId: 'other-tile',
      key: 'ctx:test',
      value: 'ignored',
    })
    cleanup()

    expect(calls).toEqual([
      { channel: 'tileContext:get', args: ['workspace-a', 'same-tile', 'ctx:test'] },
      { channel: 'tileContext:getAll', args: ['workspace-a', 'same-tile', 'ctx:'] },
      { channel: 'tileContext:set', args: ['workspace-a', 'same-tile', 'ctx:test', 'value-a'] },
      { channel: 'tileContext:delete', args: ['workspace-a', 'same-tile', 'ctx:test'] },
    ])
    expect(changed).toEqual([{
      workspaceId: 'workspace-a',
      tileId: 'same-tile',
      key: 'ctx:test',
      value: 'value-a',
    }])
  })

  test('preserves workspace scope for chat stop, clear, and disposal', async () => {
    const calls: ElectrobunInvokeCall[] = []
    const facade = createElectrobunElectronFacade({
      platform: 'darwin',
      homedir: '/Users/tester',
      invoke: async (channel, args) => {
        calls.push({ channel, args })
        return { ok: true }
      },
    })

    await facade.chat.stop('workspace-a', 'same-card')
    await facade.chat.clearSession('workspace-a', 'same-card')
    await facade.chat.disposeCard('workspace-a', 'same-card')
    expect(calls).toEqual([
      { channel: 'chat:stop', args: ['workspace-a', 'same-card'] },
      { channel: 'chat:clearSession', args: ['workspace-a', 'same-card'] },
      { channel: 'chat:disposeCard', args: ['workspace-a', 'same-card'] },
    ])
  })

  test('filesystem calls without a renderer scope use the host-owned active workspace id', async () => {
    const calls: ElectrobunInvokeCall[] = []
    const facade = createElectrobunElectronFacade({
      platform: 'darwin',
      homedir: '/Users/tester',
      invoke: async (channel, args) => {
        calls.push({ channel, args })
        return channel === 'workspace:getActive'
          ? { id: 'host-workspace', path: '/trusted/workspace' }
          : true
      },
    })

    await facade.fs.writeFile('/trusted/workspace/note.md', 'content')
    expect(calls).toEqual([
      { channel: 'workspace:getActive', args: [] },
      { channel: 'fs:writeFile', args: ['/trusted/workspace/note.md', 'content', 'host-workspace'] },
    ])
  })

  test('only returns defaults for optional reads when the runtime is unavailable', () => {
    expect(getDefaultElectrobunInvokeResponse('window:isFresh')).toBe(false)
    expect(getDefaultElectrobunInvokeResponse('pets:list')).toEqual([])
    expect(getDefaultElectrobunInvokeResponse('chat:csagentModels')).toEqual({ models: [] })
    expect(getDefaultElectrobunInvokeResponse('activity:health')).toEqual({
      available: false,
      status: 'unavailable',
    })
    assert.throws(() => getDefaultElectrobunInvokeResponse('workspace:list'))
    assert.throws(() => getDefaultElectrobunInvokeResponse('settings:get'))
    assert.throws(() => getDefaultElectrobunInvokeResponse('canvas:load'))
    assert.throws(() => getDefaultElectrobunInvokeResponse('bus:publish'))
    assert.throws(() => getDefaultElectrobunInvokeResponse('activity:upsert'))
  })

  test('preserves an authoritative null host response', async () => {
    expect(await invokeElectrobunWithFallback('canvas:load', async () => null)).toBe(null)
  })

  test('unavailable secrets are explicit failures, never fake successful writes', () => {
    expect(getDefaultElectrobunInvokeResponse('secrets:set')).toMatchObject({ ok: false })
    expect(getDefaultElectrobunInvokeResponse('secrets:delete')).toMatchObject({ ok: false })
    expect(getDefaultElectrobunInvokeResponse('secrets:list')).toMatchObject({ ok: false, names: [] })
    expect(getDefaultElectrobunInvokeResponse('secrets:has')).toMatchObject({ ok: false, has: false })
  })

  test('RPC faults propagate for secrets, filesystem writes, workspace mutations, and permission replies', async () => {
    const channels = [
      'secrets:set',
      'fs:writeFile',
      'workspace:create',
      'chat:answerToolPermission',
    ]
    for (const channel of channels) {
      await assert.rejects(
        invokeElectrobunWithFallback(channel, async () => {
          throw new Error(`fault:${channel}`)
        }),
        new RegExp(`fault:${channel}`),
      )
    }
  })
})

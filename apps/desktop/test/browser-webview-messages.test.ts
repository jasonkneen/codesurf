import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import { classifyBrowserConsoleMessage } from '../src/renderer/src/components/browser/browserWebviewMessages.ts'

const context = {
  tileId: 'browser-1',
  bridgeToken: 'secret-token',
  bridgeAllowed: true,
}

describe('browser webview console protocol', () => {
  test('accepts a bridge event only for the expected token and tile channel', () => {
    const accepted = classifyBrowserConsoleMessage(JSON.stringify({
      __contex: true,
      token: 'secret-token',
      type: 'agent.update',
      channel: 'tile:browser-1',
      payload: { status: 'working' },
    }), context)
    const wrongToken = classifyBrowserConsoleMessage(JSON.stringify({
      __contex: true,
      token: 'wrong-token',
      type: 'agent.update',
      channel: 'tile:browser-1',
    }), context)
    const wrongChannel = classifyBrowserConsoleMessage(JSON.stringify({
      __contex: true,
      token: 'secret-token',
      type: 'agent.update',
      channel: 'tile:browser-2',
    }), context)

    expect(accepted).toEqual({
      kind: 'bridge',
      eventType: 'agent.update',
      payload: { status: 'working' },
    })
    expect(wrongToken).toEqual({ kind: 'ignore' })
    expect(wrongChannel).toEqual({ kind: 'ignore' })
  })

  test('fails closed when host bridge injection is not allowed', () => {
    const action = classifyBrowserConsoleMessage(JSON.stringify({
      __contex: true,
      token: 'secret-token',
      type: 'activity',
      channel: 'browser:browser-1',
    }), {
      ...context,
      bridgeAllowed: false,
    })

    expect(action).toEqual({ kind: 'ignore' })
  })

  test('preserves an invalid custom event name as data payload metadata', () => {
    const action = classifyBrowserConsoleMessage(JSON.stringify({
      __contex: true,
      token: 'secret-token',
      type: 'INVALID EVENT',
      channel: 'browser:browser-1',
      payload: { value: 7 },
    }), context)

    expect(action).toEqual({
      kind: 'bridge',
      eventType: 'data',
      payload: { value: 7, eventType: 'INVALID EVENT' },
    })
  })

  test('classifies evidence and Cluso lifecycle messages', () => {
    expect(classifyBrowserConsoleMessage('plain console output', context)).toEqual({
      kind: 'evidence',
    })
    expect(classifyBrowserConsoleMessage('__CLUSO_READY__:{"active":true}', context)).toEqual({
      kind: 'cluso-ready',
      active: true,
    })
    expect(classifyBrowserConsoleMessage('__CLUSO_ACTIVE__:{"active":false}', context)).toEqual({
      kind: 'cluso-active',
      active: false,
    })
    expect(classifyBrowserConsoleMessage('__CLUSO_ERROR__:failed', context)).toEqual({
      kind: 'cluso-error',
    })
  })

  test('ignores malformed protocol messages without turning them into evidence', () => {
    expect(classifyBrowserConsoleMessage('{"__contex"', context)).toEqual({ kind: 'ignore' })
    expect(classifyBrowserConsoleMessage('__CLUSO_ACTIVE__:not-json', context)).toEqual({
      kind: 'ignore',
    })
  })
})

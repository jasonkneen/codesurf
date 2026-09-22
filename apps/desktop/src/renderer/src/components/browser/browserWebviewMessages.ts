import type { BusEventType } from '../../../../shared/types'
import { coerceBusEventType } from '../../../../shared/busEventTypes.ts'

export type BrowserConsoleMessageAction =
  | {
    kind: 'bridge'
    eventType: BusEventType
    payload: Record<string, unknown>
  }
  | {
    kind: 'cluso-ready'
    active?: boolean
  }
  | {
    kind: 'cluso-active'
    active: boolean
  }
  | {
    kind: 'cluso-error'
  }
  | {
    kind: 'evidence'
  }
  | {
    kind: 'ignore'
  }

interface BrowserConsoleMessageContext {
  tileId: string
  bridgeToken: string
  bridgeAllowed: boolean
}

export function classifyBrowserConsoleMessage(
  message: string,
  context: BrowserConsoleMessageContext,
): BrowserConsoleMessageAction {
  if (message.startsWith('{"__contex"')) {
    if (!context.bridgeAllowed) return { kind: 'ignore' }

    try {
      const data = JSON.parse(message) as {
        __contex?: boolean
        token?: string
        type?: string
        channel?: string
        payload?: Record<string, unknown>
      }
      const expectedBrowserChannel = `browser:${context.tileId}`
      const expectedTileChannel = `tile:${context.tileId}`
      if (
        !data.__contex
        || data.token !== context.bridgeToken
        || (data.channel !== expectedBrowserChannel && data.channel !== expectedTileChannel)
      ) {
        return { kind: 'ignore' }
      }

      const eventType = coerceBusEventType(data.type)
      const payload = data.payload && typeof data.payload === 'object' ? data.payload : {}
      return {
        kind: 'bridge',
        eventType,
        payload: eventType === 'data' && data.type && data.type !== 'data'
          ? { ...payload, eventType: data.type }
          : payload,
      }
    } catch {
      return { kind: 'ignore' }
    }
  }

  if (!message.startsWith('__CLUSO_')) return { kind: 'evidence' }

  if (message.startsWith('__CLUSO_READY__')) {
    const payloadText = message.startsWith('__CLUSO_READY__:')
      ? message.slice('__CLUSO_READY__:'.length)
      : null
    if (!payloadText) return { kind: 'cluso-ready' }

    try {
      const payload = JSON.parse(payloadText) as { active?: boolean }
      return typeof payload.active === 'boolean'
        ? { kind: 'cluso-ready', active: payload.active }
        : { kind: 'cluso-ready' }
    } catch {
      return { kind: 'cluso-ready' }
    }
  }

  if (message.startsWith('__CLUSO_ACTIVE__:')) {
    try {
      const payload = JSON.parse(message.slice('__CLUSO_ACTIVE__:'.length)) as { active?: boolean }
      return { kind: 'cluso-active', active: Boolean(payload.active) }
    } catch {
      return { kind: 'ignore' }
    }
  }

  if (message.startsWith('__CLUSO_ERROR__')) return { kind: 'cluso-error' }

  return { kind: 'ignore' }
}

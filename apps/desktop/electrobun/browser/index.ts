import { Electroview } from 'electrobun/view'
import type { CodeSurfElectrobunRPC } from '../../src/shared/electrobun-rpc.ts'
import {
  createHostBackedElectrobunElectronFacade,
  createElectrobunEventHub,
  detectPlatformFromUserAgent,
  invokeElectrobunWithFallback,
} from '../../src/electrobun/browser/electron-facade.ts'

const eventHub = createElectrobunEventHub()

const rpc = Electroview.defineRPC<CodeSurfElectrobunRPC>({
  handlers: {
    requests: {
      ping: () => true,
    },
    messages: {
      event: ({ channel, payload }) => {
        eventHub.emit(channel, payload)
      },
    },
  },
})

const electroview = new Electroview({ rpc })

const invoke = async (channel: string, args: unknown[]): Promise<unknown> => {
  return await invokeElectrobunWithFallback(
    channel,
    async () => await electroview.rpc?.request.invoke({ channel, args }),
  )
}

const platform = detectPlatformFromUserAgent(globalThis.navigator?.userAgent ?? '')
const facade = createHostBackedElectrobunElectronFacade({
  invoke,
  platform,
  eventHub,
  hostHomedir: (globalThis as any).__codesurfElectrobunHostBootstrap?.homedir,
})

Object.defineProperty(globalThis, 'electron', {
  value: facade,
  configurable: true,
  enumerable: false,
  writable: false,
})

Object.defineProperty(globalThis, '__codesurfElectrobun', {
  value: {
    runtime: 'electrobun',
    rpcReady: true,
    platform,
  },
  configurable: true,
  enumerable: false,
  writable: false,
})

type RendererBridgeSelfCheck = {
  ok: boolean
  checks: Array<{ name: string, ok: boolean, error?: string }>
}

async function runRendererBridgeSelfCheck(): Promise<RendererBridgeSelfCheck | undefined> {
  if ((globalThis as any).__codesurfElectrobunHostBootstrap?.selfCheck !== true) return undefined

  // Let BrowserWindow registration finish before asking the host to broadcast
  // stream events back into this webview.
  await new Promise(resolve => setTimeout(resolve, 100))
  const checks: RendererBridgeSelfCheck['checks'] = []
  const check = async (name: string, action: () => Promise<void>): Promise<boolean> => {
    try {
      await action()
      checks.push({ name, ok: true })
      return true
    } catch (error) {
      checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }
  const requireValue = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message)
  }

  let workspace: any = null
  await check('renderer:workspace:list', async () => {
    const workspaces = await facade.workspace.list()
    requireValue(Array.isArray(workspaces) && workspaces.length > 0, 'No workspace reached the renderer bridge')
    workspace = workspaces[0]
    requireValue(typeof workspace?.id === 'string' && workspace.id, 'Renderer workspace has no id')
  })
  if (!workspace) return { ok: false, checks }

  const workspaceId = String(workspace.id)
  const workspaceDir = String(workspace.projectPaths?.[0] ?? workspace.path ?? facade.homedir)
  const cardId = `electrobun-self-check-${Date.now()}`
  const streamEvents: any[] = []
  let resolveTextEvent: (() => void) | null = null
  const textEvent = new Promise<void>(resolve => { resolveTextEvent = resolve })
  const offStream = facade.stream.onChunk((event: any) => {
    if (event?.workspaceId !== workspaceId || event?.cardId !== cardId) return
    streamEvents.push(event)
    if (event?.type === 'text') resolveTextEvent?.()
  })

  try {
    await check('renderer:chat:send-stream-stop', async () => {
      const send = facade.chat.send({
        cardId,
        workspaceId,
        workspaceDir,
        provider: 'codesurf-self-check',
        model: 'self-check',
        messages: [{ role: 'user', content: 'Exercise the packaged Electrobun chat bridge.' }],
      })
      await Promise.race([
        textEvent,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Timed out waiting for the Electrobun chat stream')), 2_000)
        }),
      ])
      const stopped = await facade.chat.stop(workspaceId, cardId)
      const sent = await send
      requireValue(sent?.ok === true, 'chat:send did not complete through the packaged bridge')
      requireValue(stopped?.ok === true, 'chat:stop did not confirm through the packaged bridge')
      requireValue(
        streamEvents.some(event => event?.type === 'text')
          && streamEvents.some(event => event?.type === 'done'),
        'The packaged bridge did not deliver text and done stream events',
      )
    })

    await check('renderer:chat:clearSession', async () => {
      const cleared = await facade.chat.clearSession(workspaceId, cardId)
      requireValue(cleared?.ok === true, 'chat:clearSession did not confirm')
    })

    let selectionReceipt = ''
    await check('renderer:chat:attachment-issue', async () => {
      const result = await facade.chat.writeTempAttachment({
        workspaceId,
        cardId,
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        mime: 'image/png',
        ext: 'png',
        filenameHint: 'bridge-self-check',
      })
      requireValue(
        result?.ok === true && result.attachment?.selectionReceipt,
        typeof result?.error === 'string' && result.error.trim()
          ? `Temporary attachment issuance failed: ${result.error}`
          : 'Temporary attachment issuance failed',
      )
      selectionReceipt = String(result.attachment.selectionReceipt)
    })
    if (selectionReceipt) {
      await check('renderer:chat:attachment-revoke', async () => {
        const revoked = await facade.chat.revokeAttachmentSelections({
          workspaceId,
          cardId,
          selectionReceipts: [selectionReceipt],
        })
        requireValue(revoked?.ok === true && revoked.revoked === 1, 'Temporary attachment revocation failed')
      })
    }
  } finally {
    offStream()
  }

  return { ok: checks.every(checkResult => checkResult.ok), checks }
}

async function reportRendererBridgeReady(): Promise<void> {
  let rendererSelfCheck: RendererBridgeSelfCheck | undefined
  try {
    rendererSelfCheck = await runRendererBridgeSelfCheck()
  } catch (error) {
    rendererSelfCheck = {
      ok: false,
      checks: [{
        name: 'renderer:self-check',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }],
    }
  }

  try {
    electroview.rpc?.send.bridgeReady({
      platform,
      homedir: facade.homedir,
      hasElectronFacade: Boolean((globalThis as any).electron),
      hasElectrobunWebviewTag: Boolean(globalThis.customElements?.get('electrobun-webview')),
      userAgent: globalThis.navigator?.userAgent,
      ...(rendererSelfCheck ? { selfCheck: rendererSelfCheck } : {}),
    })
  } catch (error) {
    console.warn('[Electrobun] bridgeReady message failed:', error)
  }
}

void reportRendererBridgeReady().catch((error) => {
  console.warn('[Electrobun] bridge readiness failed:', error)
})

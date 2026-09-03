/**
 * Broker child-process entry point.
 *
 * Spawned via Electron utilityProcess.fork(). Receives an `activate` call from
 * main, loads the extension via require(), builds a ctx proxy whose every method
 * marshals a capability call back to main over the JsonRpcPeer transport.
 *
 * Transport: parentPort message passing (not stdout — extension console.log
 * would corrupt line-framed stdout; stderr is piped separately for logging).
 *
 * SECURITY NOTE: The child is still a Node.js process with access to native
 * builtins (fs, child_process, etc.). The capability gate enforced here is only
 * over the *ctx API surface* — not a full OS-level sandbox. That is explicitly
 * accepted in the Phase 1 design (docs/BACKLOG_PLAN.md §1b). The DENIAL of
 * ctx.fs / ctx.shell capability calls is validated in main, not here.
 *
 * NO electron imports — this file is bundled as a separate rollup entry and
 * must be importable in a plain Node environment.
 */

import { JsonRpcPeer, type JsonValue } from './json-rpc.ts'
import type { ActivateParams, BusEventParams, InvokeIpcParams, InvokeToolParams } from './protocol.ts'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// ── Transport ────────────────────────────────────────────────────────────────

// utilityProcess provides process.parentPort for structured message passing.
// We use it rather than stdout to keep the extension's console output clean.
declare const process: NodeJS.Process & {
  parentPort?: {
    postMessage(msg: string): void
    on(event: 'message', listener: (e: { data: unknown }) => void): void
  }
}

function isDirectEntry(): boolean {
  try {
    return resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

export function startBrokerChildTransport(): void {
  if (!process.parentPort) {
    // Running as a standalone Node process — use stdio fallback. This is only
    // started for direct execution, not when tests import createCtxProxy().
    const peer = buildPeer(line => process.stdout.write(line + '\n'))
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => peer.feed(chunk))
  } else {
    const peer = buildPeer(line => process.parentPort!.postMessage(line))
    process.parentPort.on('message', (e: { data: unknown }) => peer.feed(String(e.data) + '\n'))
  }
}

if (process.parentPort || isDirectEntry()) {
  startBrokerChildTransport()
}

// ── State ────────────────────────────────────────────────────────────────────

// Snapshot data from ActivateParams, updated by storeUpdate notifications.
// Typed as Record<string, unknown> so extension code can write arbitrary values;
// cast to JsonObject when marshalling over the wire.
let settingsSnapshot: Record<string, unknown> = {}
let storeSnapshot: Record<string, unknown> = {}

// Registered local callbacks — keyed by the id returned to the child proxy.
const busSubscriptions = new Map<string, (event: unknown) => void>()
// Store subscribers are tracked separately from bus subscribers because the
// host pushes them over a different method (broker.storeUpdate, which carries
// no subscriptionId). Previously these were registered in busSubscriptions,
// where nothing ever dispatched them — so ctx.store.subscribe() silently never
// fired under the broker while working fine in the bundled path.
const storeSubscriptions = new Map<string, (state: Record<string, unknown>) => void>()
const mcpToolHandlers = new Map<string, (args: Record<string, unknown>) => Promise<string>>()
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()

// Cleanup function returned from extension.activate()
let extensionCleanup: (() => void) | null = null

// ── Build peer ───────────────────────────────────────────────────────────────

function buildPeer(writeLine: (line: string) => void) {
  const peer = new JsonRpcPeer(writeLine, async (method, params) => {
    switch (method) {
      case 'broker.activate':
        return handleActivate(peer, params as unknown as ActivateParams)

      case 'broker.deactivate':
        return handleDeactivate()

      case 'broker.invokeTool': {
        const p = params as unknown as InvokeToolParams
        const handler = mcpToolHandlers.get(p.registrationId)
        if (!handler) throw new Error(`No tool handler registered for id: ${p.registrationId}`)
        const result = await handler(p.args as Record<string, unknown>)
        return { result }
      }

      case 'broker.invokeIpc': {
        const p = params as unknown as InvokeIpcParams
        const handler = ipcHandlers.get(p.channel)
        if (!handler) throw new Error(`No IPC handler registered for channel: ${p.channel}`)
        const returnValue = await handler(...(p.args ?? []))
        return { returnValue: returnValue as JsonValue ?? null }
      }

      case 'broker.busEvent': {
        const p = params as unknown as BusEventParams
        const cb = busSubscriptions.get(p.subscriptionId)
        if (cb) cb(p.event)
        return { ok: true }
      }

      case 'broker.storeUpdate': {
        const p = params as { extensionId?: string; state?: Record<string, unknown> }
        if (p.state) {
          storeSnapshot = p.state
          // Fan out to ctx.store.subscribe() callbacks. Without this the
          // snapshot updated but no extension was ever told.
          for (const cb of storeSubscriptions.values()) {
            try {
              cb({ ...storeSnapshot })
            } catch (err) {
              console.error('[broker-child] store subscriber threw:', err)
            }
          }
        }
        return { ok: true }
      }

      default:
        throw new Error(`Unknown broker method: ${method}`)
    }
  })

  return peer
}

function reportAsyncCapabilityError(label: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[BrokerChild] ${label} failed: ${message}`)
}

function fireAndReport(promise: Promise<unknown>, label: string): void {
  void promise.catch(error => reportAsyncCapabilityError(label, error))
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleActivate(
  peer: JsonRpcPeer,
  params: ActivateParams,
): Promise<JsonValue> {
  const { extensionId, entryPath, settings, storeState, workspacePath } = params

  // Seed local snapshots
  settingsSnapshot = settings ?? {}
  storeSnapshot = storeState ?? {}

  // Hot-reload: clear require cache before loading
  delete require.cache[require.resolve(entryPath)]
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(entryPath)

  if (typeof mod.activate !== 'function') {
    throw new Error(`Extension "${extensionId}" has no activate() export in ${entryPath}`)
  }

  const pendingCapabilityCalls: Promise<unknown>[] = []
  const proxyCtx = createCtxProxy(
    (capability, method, args) => {
      const pending = peer.call<JsonValue>('broker.capability', { capability, method, args })
      // Track a rejection-safe view for the settle barrier below. The original
      // `pending` is what the extension gets, so its own error handling is
      // unaffected; this copy exists only so the barrier can't see a rejection
      // the extension already dealt with.
      pendingCapabilityCalls.push(pending.catch(() => undefined))
      return pending
    },
    extensionId,
    { workspacePath: typeof workspacePath === 'string' ? workspacePath : null },
  )

  const result = await mod.activate(proxyCtx)
  if (typeof result === 'function') {
    extensionCleanup = result
  }
  // activate() often registers ipc.handle synchronously via fire-and-forget.
  // Wait for those round-trips so ipcMain handlers exist before the host
  // reports activated:true (otherwise the tile's first invoke 404s).
  //
  // Settle, don't collect: a DENIED capability call is a normal outcome that
  // the extension is expected to catch itself (see the chat-only-ext fixture,
  // which try/catches ctx.relayHost.install()). Using Promise.all here made
  // any denial during activate() fail the whole activation, reporting
  // activated:false for an extension that had already handled the error.
  await Promise.all(pendingCapabilityCalls)

  return { activated: true }
}

async function handleDeactivate(): Promise<JsonValue> {
  if (extensionCleanup) {
    try {
      extensionCleanup()
    } catch (err) {
      console.error('[BrokerChild] Error in extension cleanup:', err)
    }
    extensionCleanup = null
  }
  // Allow the reply to flush before exiting
  setImmediate(() => process.exit(0))
  return { deactivated: true }
}

// ── ctx proxy ────────────────────────────────────────────────────────────────

/**
 * Creates the capability ctx proxy passed to extension activate().
 *
 * ENFORCEMENT BOUNDARY: Every method (except baseline local-only ones listed
 * below) marshals a call to main via `broker.capability`. Main validates grants
 * BEFORE executing — no validation here.
 *
 * Local-only carve-outs (no round-trip to main):
 *   - log              — console.log wrapper
 *   - settings.get / settings.getAll — snapshot reads
 *   - store.get / store.getKey       — snapshot reads
 *   - bus.subscribe    — registers callback locally, sends metadata to main
 *   - bus.unsubscribe  — removes local callback, notifies main
 *   - mcp.registerTool — registers handler locally, sends metadata to main
 *   - ipc.handle       — registers handler locally, sends metadata to main
 *   - store.subscribe  — registers callback locally
 */
export function createCtxProxy(
  call: (capability: string, method: string, args: JsonValue[]) => Promise<JsonValue>,
  extensionId: string,
  options?: { workspacePath?: string | null },
): Record<string, unknown> {
  let subCounter = 0
  const nextId = (prefix: string) => `${prefix}_${extensionId}_${++subCounter}`

  return {
    workspacePath: options?.workspacePath ?? null,
    log: (msg: string) => console.log(`[Ext:${extensionId}] ${msg}`),

    settings: {
      get: (key: string) => settingsSnapshot[key],
      getAll: () => ({ ...settingsSnapshot }),
      set: (values: Record<string, unknown>) => call('settings', 'set', [values as unknown as JsonValue]),
    },

    store: {
      get: () => ({ ...storeSnapshot }),
      getKey: (key: string) => storeSnapshot[key],
set: (patch: Record<string, unknown>) => {
  // Optimistic local update
  storeSnapshot = { ...storeSnapshot, ...patch }
  void call('store', 'set', [patch as unknown as JsonValue]).catch(() => {})
},
      replace: (value: Record<string, unknown>) => {
        storeSnapshot = { ...value }
        fireAndReport(call('store', 'replace', [value as unknown as JsonValue]), 'store.replace')
      },
      update: (fn: (current: Record<string, unknown>) => Record<string, unknown>) => {
        const next = fn({ ...storeSnapshot })
        storeSnapshot = next
        fireAndReport(call('store', 'replace', [next as unknown as JsonValue]), 'store.update')
      },
      subscribe: (cb: (state: Record<string, unknown>) => void) => {
        const id = nextId('storeSub')
        storeSubscriptions.set(id, cb)
        fireAndReport(call('store', 'subscribe', [id]), 'store.subscribe')
        return () => {
          storeSubscriptions.delete(id)
          fireAndReport(call('store', 'unsubscribe', [id]), 'store.unsubscribe')
        }
      },
    },

    bus: {
      publish: (channel: string, type: string, payload: Record<string, unknown>) =>
        call('bus', 'publish', [channel, type, payload as unknown as JsonValue]),

      subscribe: (channel: string, subscriberId: string, cb: (event: unknown) => void) => {
        const id = nextId('busSub')
        busSubscriptions.set(id, cb)
        fireAndReport(call('bus', 'subscribe', [channel, subscriberId, id]), `bus.subscribe(${channel})`)
        return id
      },

      unsubscribe: (id: string) => {
        busSubscriptions.delete(id)
        fireAndReport(call('bus', 'unsubscribe', [id]), `bus.unsubscribe(${id})`)
      },
    },

    mcp: {
      registerTool: (tool: {
        name: string
        description: string
        inputSchema: Record<string, unknown>
        handler: (args: Record<string, unknown>) => Promise<string>
      }) => {
        const registrationId = nextId('tool')
        mcpToolHandlers.set(registrationId, tool.handler)
        fireAndReport(call('mcp', 'registerTool', [{
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as unknown as JsonValue,
          registrationId,
        } as unknown as JsonValue]), `mcp.registerTool(${tool.name})`)
      },
    },

    ipc: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        const fullChannel = `ext:${extensionId}:${channel}`
        ipcHandlers.set(fullChannel, handler)
        fireAndReport(call('ipc', 'handle', [fullChannel]), `ipc.handle(${fullChannel})`)
      },
    },

    relayHost: {
      install: () => call('relayHost', 'install', []),
    },
  }
}

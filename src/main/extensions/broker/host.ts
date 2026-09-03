/**
 * ExtensionBrokerHost — main-process side of the brokered extension execution tier.
 *
 * Spawns extension code in a utilityProcess (crash-isolated, separate OS process),
 * validates every capability call against the extension's grants BEFORE dispatching
 * to the real ExtensionContext executors, and handles crash recovery by emitting a
 * bus event without taking down main.
 *
 * Usage:
 *   const host = new ExtensionBrokerHost(manifest, bus, registry)
 *   await host.activate()
 *   // ... later ...
 *   await host.deactivate()
 */

import { join, resolve, sep } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { ipcMain } from 'electron'
import { bus } from '../../event-bus'
import { ExtensionContext } from '../context'
import { getPluginState } from '../plugin-store'
import type { ExtensionManifest } from '../../../shared/types'
import type { ExtensionHostRegistry } from '../registry'
import type { ExtensionScope } from '../loader'
import { validateCapabilityCall } from './policy'
import { JsonRpcPeer, type JsonValue, type JsonObject } from './json-rpc'
import { BROKER_ERROR_CODES } from './protocol'
import { registerRelayIPC, unregisterRelayIPC } from '../../ipc/relay'
import { log } from '../../utils/logger.ts'

export class ExtensionBrokerHost {
  private child: UtilityProcess | null = null
  private peer: JsonRpcPeer | null = null
  private ctx: ExtensionContext | null = null
  private deliberateExit = false
  private active = false
  private ipcChannels: string[] = []
  /**
   * child-local bus subscription id -> real EventBus subscription id.
   *
   * The child mints its own `busSub_*` id (so it can register the callback
   * synchronously) and sends that on both subscribe and unsubscribe. The real
   * id only exists here. Without this mapping, unsubscribe passed the child id
   * to EventBus.unsubscribe, matched nothing, and left the main-side
   * subscription alive — still forwarding every event over IPC to a callback
   * the child had already dropped.
   */
  private busSubscriptionIds = new Map<string, string>()

  constructor(
    private manifest: ExtensionManifest,
    private registry: ExtensionHostRegistry,
    // scope is carried for audit logging by the caller; not used inside the host
    _scope: ExtensionScope,
  ) {}

  get isActive(): boolean {
    return this.active
  }

  async activate(): Promise<boolean> {
    if (this.active) return false

    const manifest = this.manifest
    if (!manifest.main || !manifest._path) return false

    // Block path traversal: ensure manifest.main stays within the extension directory
    const resolvedBase = resolve(manifest._path)
    const resolvedEntry = resolve(manifest._path, manifest.main)
    if (resolvedEntry !== resolvedBase && !resolvedEntry.startsWith(resolvedBase + sep)) {
      console.error(
        `[Security] Blocked activation of extension "${manifest.id}": ` +
        `manifest.main "${manifest.main}" escapes extension directory`,
      )
      return false
    }

    const entryPath = join(manifest._path, manifest.main)
    const extId = manifest.id

    // Build a real ExtensionContext in main — all executors live here
    const ctx = new ExtensionContext(manifest, bus, this.registry)
    this.ctx = ctx

    // Compute the child bundle path — same dir as the compiled main bundle
    const childBundle = join(__dirname, 'broker-child.js')

    this.deliberateExit = false

    const child = utilityProcess.fork(childBundle, [], {
      serviceName: `ext:${extId}`,
      stdio: 'pipe',
      env: {
        ...process.env,
        CODESURF_BROKER_CHILD: '1',
      },
    })
    this.child = child

    // Pipe child stdout/stderr to main logs with a prefix
    const prefix = `[Ext:${manifest.name}]`
    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (line.trim()) log.debug(`${prefix} ${line}`)
        }
      })
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (line.trim()) console.error(`${prefix} STDERR: ${line}`)
        }
      })
    }

    // Transport: parentPort message passing
    const peer = new JsonRpcPeer(
      line => {
        if (this.child) {
          child.postMessage(line)
        }
      },
      async (method, params) => this.handleChildCall(method, params),
    )
    this.peer = peer

    child.on('message', (data: unknown) => {
      peer.feed(String(data) + '\n')
    })

    child.once('exit', (code) => {
      peer.close(`Extension child exited: code=${code ?? 'null'}`)
      if (!this.deliberateExit) {
        console.error(`${prefix} Crashed unexpectedly (exit code: ${code}). Main process unaffected.`)
        this.ctx?.dispose()
        // Remove broker-registered ipcMain handlers — they are tracked only in
        // this.ipcChannels (registered directly via ipcMain.handle, not through
        // ctx), so ctx.dispose() does NOT clean them. Without this, a child that
        // registers an IPC handler then crashes leaks the ext:{id}:* channel and
        // re-activation throws Electron's "second handler" error.
        for (const ch of this.ipcChannels) {
          ipcMain.removeHandler(ch)
        }
        this.ipcChannels = []
        this.ctx = null
        this.peer = null
        this.child = null
        this.active = false
        bus.publish({
          channel: 'extensions',
          type: 'extension-crashed',
          source: 'broker',
          payload: { extId, code: code ?? null, name: manifest.name },
        })
      }
    })

    // Get grant data from registry
    const gate = this.registry.getCapabilityGate(extId)
    const settings = ctx.settings.getAll()
    const storeState = getPluginState(extId) as JsonObject

    try {
      const result = await peer.call<JsonObject>('broker.activate', {
        extensionId: extId,
        entryPath,
        grantedCapabilities: gate.granted,
        settings: settings as JsonObject,
        storeState,
        workspacePath: this.registry.getActiveWorkspacePath(),
      }, 30_000)

      this.active = !!result.activated
      log.debug(`${prefix} Brokered activation ${this.active ? 'succeeded' : 'failed'}`)
      return this.active
    } catch (err) {
      console.error(`${prefix} Broker activate failed:`, err)
      this.cleanup()
      return false
    }
  }

  async deactivate(): Promise<void> {
    if (!this.active) return
    this.deliberateExit = true
    this.active = false

    const peer = this.peer
    const child = this.child
    const ctx = this.ctx

    // Clear references before async work so re-entry is safe
    this.peer = null
    this.child = null
    this.ctx = null
    // ctx.dispose() drops the underlying bus subscriptions; drop our id map too
    // so a re-activated host cannot resolve stale ids.
    this.busSubscriptionIds.clear()

    if (peer) {
      try {
        await peer.call('broker.deactivate', { extensionId: this.manifest.id, reason: 'deactivate' }, 5_000)
      } catch {
        // Ignore — kill the child anyway
      }
      peer.close('deactivated')
    }

    if (child) {
      child.kill()
    }

    for (const ch of this.ipcChannels) {
      ipcMain.removeHandler(ch)
    }
    this.ipcChannels = []

    ctx?.dispose()
  }

  /** Returns a cleanup function compatible with the loadPowerExtension return value. */
  buildCleanupFn(): () => void {
    return () => {
      void this.deactivate()
    }
  }

  // ── Capability dispatcher (main-side) ──────────────────────────────────────

  private async handleChildCall(method: string, params: JsonObject): Promise<JsonValue> {
    if (method !== 'broker.capability') {
      throw new Error(`Unexpected method from child: ${method}`)
    }

    const { capability, method: capMethod, args } = params as {
      capability: string
      method: string
      args: JsonValue[]
    }

    const extId = this.manifest.id
    const gate = this.registry.getCapabilityGate(extId)
    const check = validateCapabilityCall(gate, extId, capability, capMethod)

    if (!check.ok) {
      const code = BROKER_ERROR_CODES[check.code]
      throw Object.assign(new Error(check.message), { code })
    }

    if (!this.ctx) {
      throw Object.assign(new Error(`Extension "${extId}" context is not available`), {
        code: BROKER_ERROR_CODES['deactivated'],
      })
    }

    return this.dispatch(capability, capMethod, args)
  }

  private async dispatch(
    capability: string,
    method: string,
    args: JsonValue[],
  ): Promise<JsonValue> {
    const ctx = this.ctx!
    const extId = this.manifest.id
    const peer = this.peer!

    switch (capability) {
      case 'bus': {
        switch (method) {
          case 'publish': {
            const [channel, type, payload] = args as [string, string, JsonObject]
            ctx.bus.publish(channel, type, payload as Record<string, unknown>)
            return { ok: true }
          }
          case 'subscribe': {
            // args: [channel, subscriberId, childSubscriptionId]
            const [channel, subscriberId, childSubId] = args as [string, string, string]
            const subId = ctx.bus.subscribe(channel, subscriberId, (event) => {
              if (peer) {
                void peer.call('broker.busEvent', {
                  subscriptionId: childSubId,
                  event: (event ?? {}) as JsonObject,
                })
              }
            })
            this.busSubscriptionIds.set(childSubId, subId)
            return { subscriptionId: subId }
          }
          case 'unsubscribe': {
            // The child sends its own id; translate to the real one. Fall back
            // to the raw value so a caller that somehow holds a real id still
            // works.
            const [id] = args as [string]
            const realId = this.busSubscriptionIds.get(id) ?? id
            this.busSubscriptionIds.delete(id)
            ctx.bus.unsubscribe(realId)
            return { ok: true }
          }
          default:
            throw new Error(`Unknown bus method: ${method}`)
        }
      }

      case 'mcp': {
        if (method !== 'registerTool') throw new Error(`Unknown mcp method: ${method}`)
        const toolArg = args[0] as {
          name: string
          description: string
          inputSchema: JsonObject
          registrationId: string
        }
        ctx.mcp.registerTool({
          name: toolArg.name,
          description: toolArg.description,
          inputSchema: toolArg.inputSchema as Record<string, unknown>,
          handler: async (toolArgs) => {
            const result = await peer.call<{ result: string }>('broker.invokeTool', {
              registrationId: toolArg.registrationId,
              args: toolArgs as JsonObject,
            }, 30_000)
            return result.result
          },
        })
        return { ok: true }
      }

      case 'ipc': {
        if (method !== 'handle') throw new Error(`Unknown ipc method: ${method}`)
        const [fullChannel] = args as [string]
        const expectedPrefix = `ext:${extId}:`
        if (!fullChannel.startsWith(expectedPrefix)) {
          throw Object.assign(
            new Error(
              `Extension "${extId}" attempted to register IPC handler on unauthorized channel ` +
              `"${fullChannel}". Channels must start with "${expectedPrefix}".`,
            ),
            { code: BROKER_ERROR_CODES['capability-denied'] },
          )
        }
        // Register directly with ipcMain — ExtensionContext.ipc.handle namespaces
        // with ext:{id}:, but the child already sends the full channel.
        //
        // Registration is intentionally replacement-safe for this extension's
        // own namespace. A hot reload, overlapping scan, or extension bug can
        // re-register the same ext:{id}:* channel; Electron throws on duplicate
        // ipcMain.handle(), and that rejection used to surface as unhandled
        // broker-child warnings. Remove the previous owned handler first so the
        // latest child owns the channel deterministically.
        if (this.ipcChannels.includes(fullChannel)) {
          ipcMain.removeHandler(fullChannel)
          this.ipcChannels = this.ipcChannels.filter(channel => channel !== fullChannel)
        }
        ipcMain.handle(fullChannel, async (_event, ...ipcArgs) => {
          const result = await peer.call<{ returnValue: JsonValue }>('broker.invokeIpc', {
            channel: fullChannel,
            args: ipcArgs as JsonValue[],
          }, 30_000)
          return result.returnValue
        })
        this.ipcChannels.push(fullChannel)
        return { ok: true }
      }

      case 'settings': {
        switch (method) {
          case 'set': {
            const [values] = args as [Record<string, unknown>]
            ctx.settings.set(values)
            return { ok: true }
          }
          default:
            throw new Error(`Unknown settings method: ${method}`)
        }
      }

      case 'store': {
        switch (method) {
          case 'set': {
            const [patch] = args as [Record<string, unknown>]
            ctx.store.set(patch)
            return { ok: true }
          }
          case 'replace': {
            const [value] = args as [Record<string, unknown>]
            ctx.store.replace(value)
            return { ok: true }
          }
          case 'subscribe': {
            // args: [childSubscriptionId] — the child has already registered a
            // local callback under this id; push updates via broker.storeUpdate.
            const [childSubId] = args as [string]
            ctx.store.subscribe((state) => {
              if (peer) {
                void peer.call('broker.storeUpdate', {
                  extensionId: extId,
                  state: state as JsonObject,
                })
              }
            })
            return { subscriptionId: childSubId }
          }
          case 'unsubscribe':
            // Store subscribe returns an unsubscribe fn internally; we don't
            // expose per-subscription unsubscribe over the broker in v1.
            return { ok: true }
          default:
            throw new Error(`Unknown store method: ${method}`)
        }
      }

      case 'relayHost': {
        if (method !== 'install') throw new Error(`Unknown relayHost method: ${method}`)
        if (this.manifest.id !== 'codesurf-relay-suite') {
          // Hardcoded transition: only codesurf-relay-suite can call this until
          // all installed relay suites declare the 'relay' capability explicitly.
          throw Object.assign(
            new Error(`relayHost.install is only available to codesurf-relay-suite (got: ${this.manifest.id})`),
            { code: BROKER_ERROR_CODES['capability-denied'] },
          )
        }
        registerRelayIPC()
        // Register a cleanup so deactivate() stops the relay services.
        const origDispose = this.ctx!.dispose.bind(this.ctx)
        this.ctx!.dispose = () => {
          void unregisterRelayIPC().catch(error => {
            console.warn('[Relay] Failed to stop brokered relay host:', error)
          })
          origDispose()
        }
        return { ok: true }
      }

      default:
        throw new Error(`No executor for capability: ${capability}`)
    }
  }

  private cleanup(): void {
    this.peer?.close('cleanup')
    this.peer = null
    if (this.child) {
      this.child.kill()
      this.child = null
    }
    for (const ch of this.ipcChannels) {
      ipcMain.removeHandler(ch)
    }
    this.ipcChannels = []
    this.ctx?.dispose()
    this.ctx = null
    this.active = false
  }
}

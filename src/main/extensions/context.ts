/**
 * ExtensionContext — the API surface passed to power tier extensions.
 *
 * Usage in extension main.js:
 *   module.exports = {
 *     activate(ctx) {
 *       ctx.mcp.registerTool({ name: 'my_tool', ... })
 *       ctx.bus.subscribe('tile:*', 'my-ext', (event) => { ... })
 *       return () => { // cleanup }
 *     }
 *   }
 */

import { ipcMain } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { EventBus } from '../event-bus'
import type { ExtensionManifest, ExtensionMCPToolContrib } from '../../shared/types'
import type { ExtensionHostRegistry } from './registry'
import { registerRelayIPC, unregisterRelayIPC } from '../ipc/relay'
import { CODESURF_HOME } from '../paths'
import { getPluginState, setPluginState, replacePluginState, stateChannel } from './plugin-store'
import { log } from '../utils/logger.ts'

interface RegisteredTool extends ExtensionMCPToolContrib {
  handler?: (args: Record<string, unknown>) => Promise<string>
}

export class ExtensionContext {
  private registeredTools: RegisteredTool[] = []
  private ipcHandlers: string[] = []
  private busSubscriptions: string[] = []

  readonly bus: {
    publish: (channel: string, type: string, payload: Record<string, unknown>) => void
    subscribe: (channel: string, subscriberId: string, cb: (event: unknown) => void) => string
    unsubscribe: (id: string) => void
  }

  readonly mcp: {
    registerTool: (tool: {
      name: string
      description: string
      inputSchema: Record<string, unknown>
      handler: (args: Record<string, unknown>) => Promise<string>
    }) => void
  }

  readonly ipc: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => void
  }

  /**
   * Relay Suite only: registers relay:* IPC + CodesurfRelay host. Returns dispose
   * (unregister IPC + stop relay services). Core app does not register relay.
   */
  readonly relayHost: { install: () => () => void } | undefined

  readonly settings: {
    /** Persisted value (merged over the manifest default), or the default, or undefined. */
    get: (key: string) => unknown
    /** All settings: manifest defaults overlaid with persisted values. */
    getAll: () => Record<string, unknown>
    /** Persist values (filtered to declared keys), merged into the existing file. */
    set: (values: Record<string, unknown>) => void
  }

  /**
   * Durable, reactive per-plugin state (~/.codesurf/plugin-state/<id>.json).
   * Changes broadcast on the bus so the host, this plugin's iframe, and peer
   * plugins stay in sync. Unlike settings (declared keys only), the store holds
   * arbitrary runtime state.
   */
  readonly store: {
    /** The full state object. */
    get: () => Record<string, unknown>
    /** A single key. */
    getKey: <T = unknown>(key: string) => T | undefined
    /** Shallow-merge a patch. */
    set: (patch: Record<string, unknown>) => void
    /** Replace the entire state. */
    replace: (value: Record<string, unknown>) => void
    /** Read-modify-write. */
    update: (fn: (current: Record<string, unknown>) => Record<string, unknown>) => void
    /** Subscribe to state changes; returns an unsubscribe fn. */
    subscribe: (cb: (state: Record<string, unknown>) => void) => () => void
  }

  readonly log: (msg: string) => void

  /** Active workspace directory when the extension was activated, or null. */
  readonly workspacePath: string | null

  constructor(
    manifest: ExtensionManifest,
    private eventBus: EventBus,
    private registry: ExtensionHostRegistry,
  ) {
    const extId = manifest.id
    const prefix = `[Ext:${manifest.name}]`
    this.relayHost = undefined
    this.workspacePath = registry.getActiveWorkspacePath()

    // ── Bus API ──
    this.bus = {
      publish: (channel, type, payload) => {
        this.eventBus.publish({
          channel,
          type: type as any,
          source: `ext:${extId}`,
          payload,
        })
      },
      subscribe: (channel, subscriberId, cb) => {
        const sub = this.eventBus.subscribe(channel, subscriberId, cb as any)
        this.busSubscriptions.push(sub.id)
        return sub.id
      },
      unsubscribe: (id) => {
        this.eventBus.unsubscribe(id)
        this.busSubscriptions = this.busSubscriptions.filter(s => s !== id)
      },
    }

    // ── MCP API ──
    this.mcp = {
      registerTool: (tool) => {
        const registered: RegisteredTool = {
          name: `ext_${extId}_${tool.name}`,
          description: tool.description,
          inputSchema: tool.inputSchema,
          handler: tool.handler,
        }
        this.registeredTools.push(registered)
        this.registry.registerMCPTool(extId, registered)
        log.debug(`${prefix} Registered MCP tool: ${registered.name}`)
      },
    }

    // ── IPC API (namespaced to ext:{extId}:*) ──
    this.ipc = {
      handle: (channel, handler) => {
        const fullChannel = `ext:${extId}:${channel}`
        ipcMain.handle(fullChannel, async (_event, ...args) => {
          return handler(...args)
        })
        this.ipcHandlers.push(fullChannel)
        log.debug(`${prefix} Registered IPC: ${fullChannel}`)
      },
    }

    if (manifest.id === 'codesurf-relay-suite') {
      this.relayHost = {
        install: () => {
          registerRelayIPC()
          return () => {
            void unregisterRelayIPC().catch(error => {
              console.warn('[Relay] Failed to stop relay host:', error)
            })
          }
        },
      }
    }

    // ── Settings API ──
    // Persisted at ~/.codesurf/extension-settings/{extId}.json — the same file the
    // renderer bridge and ext:settings-* IPC use. Previously this only returned the
    // manifest default and never read the user's saved value (a bug); now it merges
    // persisted values over defaults, and can write them back.
    const settingsFile = join(CODESURF_HOME, 'extension-settings', `${extId}.json`)
    // Declared keys come from v1 contributes.settings and v2 settingsSections controls.
    const declaredKeys = (): Set<string> => {
      const keys = new Set<string>()
      for (const s of manifest.contributes?.settings ?? []) keys.add(s.key)
      for (const section of manifest.contributes?.settingsSections ?? []) {
        for (const item of section.items) {
          if ('key' in item && item.key) keys.add(item.key)
        }
      }
      return keys
    }
    const defaults = (): Record<string, unknown> => {
      const out: Record<string, unknown> = {}
      for (const s of manifest.contributes?.settings ?? []) {
        if (s.default !== undefined) out[s.key] = s.default
      }
      for (const section of manifest.contributes?.settingsSections ?? []) {
        for (const item of section.items) {
          if ('key' in item && item.key && 'default' in item && item.default !== undefined) {
            out[item.key] = item.default
          }
        }
      }
      return out
    }
    const readPersisted = (): Record<string, unknown> => {
      try {
        return JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>
      } catch {
        return {}
      }
    }
    this.settings = {
      getAll: () => ({ ...defaults(), ...readPersisted() }),
      get: (key) => {
        const merged = { ...defaults(), ...readPersisted() }
        return merged[key]
      },
      set: (values) => {
        const allowed = declaredKeys()
        const filtered = Object.fromEntries(
          Object.entries(values ?? {}).filter(([key]) => allowed.has(key)),
        )
        const next = { ...readPersisted(), ...filtered }
        mkdirSync(join(CODESURF_HOME, 'extension-settings'), { recursive: true })
        writeFileSync(settingsFile, JSON.stringify(next, null, 2))
      },
    }

    // ── Store API (durable reactive state; see plugin-store.ts) ──
    this.store = {
      get: () => getPluginState(extId),
      getKey: <T = unknown>(key: string) => getPluginState(extId)[key] as T | undefined,
      set: (patch) => { setPluginState(extId, patch) },
      replace: (value) => { replacePluginState(extId, value) },
      update: (fn) => { replacePluginState(extId, fn(getPluginState(extId))) },
      subscribe: (cb) => {
        const sub = this.eventBus.subscribe(
          stateChannel(extId),
          `ext:${extId}:store`,
          (evt: unknown) => {
            const payload = (evt as { payload?: { state?: Record<string, unknown> } })?.payload
            cb(payload?.state ?? {})
          },
        )
        this.busSubscriptions.push(sub.id)
        return () => {
          this.eventBus.unsubscribe(sub.id)
          this.busSubscriptions = this.busSubscriptions.filter(s => s !== sub.id)
        }
      },
    }

    // ── Logger ──
    this.log = (msg) => log.debug(`${prefix} ${msg}`)
  }

  /** Get tools registered by this extension's activate() */
  getRegisteredTools(): RegisteredTool[] {
    return [...this.registeredTools]
  }

  /** Cleanup everything this extension registered */
  dispose(): void {
    for (const id of this.busSubscriptions) {
      this.eventBus.unsubscribe(id)
    }
    for (const channel of this.ipcHandlers) {
      ipcMain.removeHandler(channel)
    }
    this.busSubscriptions = []
    this.ipcHandlers = []
    this.registeredTools = []
  }
}

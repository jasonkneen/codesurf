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
import type { EventBus } from '../event-bus'
import type { ExtensionManifest, ExtensionMCPToolContrib } from '../../shared/types'
import type { ExtensionRegistry } from './registry'

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

  readonly settings: {
    get: (key: string) => unknown
  }

  readonly log: (msg: string) => void

  constructor(
    manifest: ExtensionManifest,
    private eventBus: EventBus,
    private registry: ExtensionRegistry,
  ) {
    const extId = manifest.id
    const prefix = `[Ext:${manifest.name}]`

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
        console.log(`${prefix} Registered MCP tool: ${registered.name}`)
      },
    }

    // ── IPC API (namespaced to ext:{extId}:*) ──
    this.ipc = {
      handle: (channel, handler) => {
        const fullChannel = `ext:${extId}:${channel}`
        ipcMain.handle(fullChannel, async (event, ...args) => {
          return handler(...args)
        })
        this.ipcHandlers.push(fullChannel)
        console.log(`${prefix} Registered IPC: ${fullChannel}`)
      },
    }

    // ── Settings API ──
    this.settings = {
      get: (key) => {
        // Read from extension's contributed settings defaults for now
        const setting = manifest.contributes?.settings?.find(s => s.key === key)
        return setting?.default
      },
    }

    // ── Logger ──
    this.log = (msg) => console.log(`${prefix} ${msg}`)
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

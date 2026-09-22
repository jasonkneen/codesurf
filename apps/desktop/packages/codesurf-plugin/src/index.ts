/**
 * @codesurf/plugin — the typed authoring SDK for CodeSurf plugins.
 *
 * Import this in a plugin to get a fully-typed manifest (`definePlugin`) and typed
 * access to the host bridge (`window.codesurf`). It is intentionally self-contained
 * (no imports from the app internals) so it is the stable public contract authors
 * code against — the "piss-easy + typed" authoring path.
 *
 *   import { definePlugin } from '@codesurf/plugin'
 *   export default definePlugin({
 *     id: 'my-plugin', name: 'My Plugin', version: '1.0.0', manifestVersion: 2,
 *     contributes: { commands: [{ id: 'my.hi', title: 'My: Hi', slash: 'hi' }] },
 *   })
 *
 * And inside an iframe surface:
 *   import type { CodesurfBridge } from '@codesurf/plugin'
 *   const cx = (window as { codesurf?: CodesurfBridge }).codesurf
 *   cx?.canvas.createTile('code')
 */

// ─── Axes ────────────────────────────────────────────────────────────────────
export type PluginKind = 'codesurf' | 'community' | 'agent'
export type PluginExecutionMode = 'iframe' | 'node' | 'worker'
export type PluginRenderMode = 'iframe' | 'component' | 'mcp-ui'
export type PluginCapabilityName =
  | 'fs' | 'network' | 'shell' | 'chat' | 'daemon' | 'chrome' | 'secrets' | 'relay' | 'canvas'
  | 'microphone' | 'camera' | 'display-capture'

// ─── Contribution shapes ──────────────────────────────────────────────────────
export interface PluginCapabilityRequest { name: PluginCapabilityName | string; reason?: string; scope?: string[] }
export interface PluginCommand {
  id: string; title: string; palette?: boolean; slash?: string; icon?: string
  category?: string; keybinding?: string; when?: string; run?: { method?: string; action?: string }
}
export interface PluginFooterItem { id: string; entry?: string; label?: string; icon?: string; render?: PluginRenderMode; position?: 'left' | 'right'; order?: number }
export interface PluginPanel { id: string; title: string; entry?: string; icon?: string; region?: 'left' | 'right' | 'bottom'; render?: PluginRenderMode; order?: number }
export type PluginSettingControl =
  | { kind: 'toggle'; key: string; label: string; default?: boolean; description?: string }
  | { kind: 'text'; key: string; label: string; default?: string; placeholder?: string; description?: string }
  | { kind: 'number'; key: string; label: string; default?: number; min?: number; max?: number; step?: number; description?: string }
  | { kind: 'select'; key: string; label: string; default?: string; options: Array<{ value: string; label: string }>; description?: string }
  | { kind: 'button'; label: string; command: string; description?: string }
export interface PluginSettingsSection { id: string; title: string; icon?: string; order?: number; items: PluginSettingControl[] }
export interface PluginTile { type: string; label: string; icon?: string; entry: string; defaultSize?: { w: number; h: number }; minSize?: { w: number; h: number } }
export interface PluginChatSurface { id: string; label: string; description?: string; icon?: string; entry: string; emits?: 'image' | 'text'; defaultHeight?: number; minHeight?: number }
export interface PluginContextMenuItem { label: string; action: string; tileType?: string }
export interface PluginMcpTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface PluginLayoutNode { type: 'leaf' | 'split'; direction?: 'horizontal' | 'vertical'; sizes?: number[]; children?: PluginLayoutNode[]; slots?: Array<{ tileType: string; label?: string }> }
export interface PluginLayoutPreset { id: string; title: string; icon?: string; layout: PluginLayoutNode }
export interface PluginAgentExtension { path: string }
export interface PluginLegacySetting { key: string; label: string; type: 'string' | 'number' | 'boolean'; default?: unknown }

export interface PluginContributions {
  tiles?: PluginTile[]
  chatSurfaces?: PluginChatSurface[]
  contextMenu?: PluginContextMenuItem[]
  mcpTools?: PluginMcpTool[]
  settings?: PluginLegacySetting[]
  commands?: PluginCommand[]
  footer?: PluginFooterItem[]
  panels?: PluginPanel[]
  settingsSections?: PluginSettingsSection[]
  layoutPresets?: PluginLayoutPreset[]
  agentExtensions?: PluginAgentExtension[]
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  manifestVersion?: 1 | 2
  kind?: PluginKind
  engines?: { codesurf?: string }
  /** Trust/runtime. Alias of legacy `tier`: safe⇒iframe, power⇒node. */
  execution?: PluginExecutionMode
  /** Default render. Alias of legacy `ui.mode`: custom⇒iframe, native⇒mcp-ui. */
  render?: PluginRenderMode
  /** Legacy trust tier (still honoured). */
  tier?: 'safe' | 'power'
  ui?: { mode?: 'native' | 'custom' }
  capabilities?: PluginCapabilityRequest[]
  dependsOn?: string[]
  contributes?: PluginContributions
  main?: string
  permissions?: string[]
}

/** Identity helper — gives full type-checking + IntelliSense on a plugin manifest. */
export function definePlugin<T extends PluginManifest>(manifest: T): T {
  return manifest
}

// ─── Host bridge (window.codesurf / window.contex) ────────────────────────────
export interface CodesurfBridge {
  tileId: string
  extId: string
  tile: {
    getState: (key?: string) => Promise<unknown>
    setState: (keyOrData: string | Record<string, unknown>, value?: unknown) => Promise<unknown>
    getSize: () => Promise<{ width: number; height: number }>
    onResize: (cb: (size: { width: number; height: number }) => void) => () => void
    getMeta: () => Promise<unknown>
  }
  bus: {
    publish: (channel: string, type: string, payload: Record<string, unknown>) => Promise<unknown>
    subscribe: (channel: string, cb: (event: unknown) => void) => Promise<unknown>
  }
  canvas: {
    createTile: (type: string, opts?: Record<string, unknown>) => Promise<unknown>
    listTiles: () => Promise<unknown>
  }
  settings: { get: (key: string) => Promise<unknown>; set: (settings: Record<string, unknown>) => Promise<unknown> }
  /** Durable reactive per-plugin store. */
  store: {
    get: () => Promise<Record<string, unknown>>
    set: (patch: Record<string, unknown>) => Promise<unknown>
    replace: (value: Record<string, unknown>) => Promise<unknown>
    subscribe: (cb: (state: Record<string, unknown>) => void) => Promise<unknown>
  }
  ext: { invoke: (method: string, ...args: unknown[]) => Promise<unknown> }
  workspace: { getPath: () => Promise<string | null> }
}

declare global {
  interface Window {
    codesurf?: CodesurfBridge
    contex?: CodesurfBridge
  }
}

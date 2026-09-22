import type { LayoutTemplateNode } from './types.ts'

// ─── Extension System Types ─────────────────────────────────────────────────

export interface ExtensionActionContrib {
  name: string
  description: string
}

export interface ExtensionChatModel {
  id: string
  label: string
  description?: string
}

export interface ExtensionChatTransportConfig {
  type: 'local-proxy'
  baseUrl: string
  apiKey?: string
  autoStart?: boolean
}

export interface ExtensionChatProviderConfig {
  id: string
  label: string
  description?: string
  noun?: 'model' | 'agent'
  icon?: 'bot' | 'server' | 'plug'
  models: ExtensionChatModel[]
  transport: ExtensionChatTransportConfig
}

export interface ExtensionUIContrib {
  /** Native = should look/feel like core app UI. Custom = extension owns its bespoke surface. */
  mode?: 'native' | 'custom'
}

export interface ExtensionContextDeclaration {
  produces?: string[]
  consumes?: string[]
}

export interface ExtensionManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  tier: 'safe' | 'power'
  ui?: ExtensionUIContrib

  // ─── v2 plugin fields (all optional; absent ⇒ legacy v1 behaviour) ──────────
  // See docs/plugins/00-architecture.md. The two trust/render axes are orthogonal
  // and derived from tier/ui.mode when omitted (see normalizeManifestAxes).
  /** Schema/format version. Absent or 1 ⇒ legacy v1 manifest. */
  manifestVersion?: 1 | 2
  /** Gallery classification. */
  kind?: PluginKind
  /** Host compatibility (semver range), e.g. ">=0.1.0". */
  engines?: { codesurf?: string }
  /** Trust/runtime of plugin logic. Alias of tier: safe⇒iframe, power⇒node. */
  execution?: PluginExecutionMode
  /** Default surface render mode. Alias of ui.mode: custom⇒iframe, native⇒mcp-ui. */
  render?: PluginRenderMode
  /** Host capabilities requested; consented at enable/install time. Supersedes permissions[]. */
  capabilities?: ExtensionCapabilityRequest[]
  /** Other plugin ids this plugin needs loaded first (load order + typed access). */
  dependsOn?: string[]

  contributes?: {
    tiles?: ExtensionTileEntry[]
    chatSurfaces?: ExtensionChatSurfaceEntry[]
    mcpTools?: ExtensionMCPToolContrib[]
    contextMenu?: ExtensionContextMenuContrib[]
    settings?: ExtensionSettingContrib[]
    actions?: ExtensionActionContrib[]
    context?: ExtensionContextDeclaration
    // ─── v2 contributions (all optional) ──────────────────────────────────────
    commands?: ExtensionCommandContrib[]
    footer?: ExtensionFooterContrib[]
    panels?: ExtensionPanelContrib[]
    settingsSections?: ExtensionSettingsSectionContrib[]
    layoutPresets?: ExtensionLayoutPresetContrib[]
    agentExtensions?: ExtensionAgentExtensionContrib[]
  }
  main?: string
  permissions?: string[]
  _path?: string
  _enabled?: boolean
  _adapter?: string
}

// ─── v2 plugin enums + contribution shapes ───────────────────────────────────

export type PluginKind = 'codesurf' | 'community' | 'agent'
/** Trust/runtime axis (orthogonal to render). worker = utilityProcess (future). */
export type PluginExecutionMode = 'iframe' | 'node' | 'worker'
/** Paint axis (orthogonal to execution). mcp-ui = MCP-UI resource themed by the host. */
export type PluginRenderMode = 'iframe' | 'component' | 'mcp-ui'

/** Named host capabilities a plugin can request (consented at enable time). */
export const PLUGIN_CAPABILITY_NAMES = [
  'fs',
  'network',
  'shell',
  'chat',
  'daemon',
  'chrome',
  'secrets',
  'relay',
  'canvas',
  'microphone',
  'camera',
  'display-capture',
] as const

export type PluginCapabilityName = typeof PLUGIN_CAPABILITY_NAMES[number]

const PLUGIN_CAPABILITY_NAME_SET = new Set<string>(PLUGIN_CAPABILITY_NAMES)

export function isPluginCapabilityName(value: unknown): value is PluginCapabilityName {
  return typeof value === 'string' && PLUGIN_CAPABILITY_NAME_SET.has(value)
}

export interface ExtensionCapabilityRequest {
  name: PluginCapabilityName
  /** Shown to the user at the consent step. */
  reason?: string
  /** Optional scoping hint (e.g. fs path globs). Interpretation is capability-specific. */
  scope?: string[]
}

export function isValidExtensionCapabilityRequests(
  value: unknown,
): value is ExtensionCapabilityRequest[] {
  if (!Array.isArray(value) || value.length > PLUGIN_CAPABILITY_NAMES.length) {
    return false
  }
  const seen = new Set<PluginCapabilityName>()
  for (const request of value) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return false
    const candidate = request as {
      name?: unknown
      reason?: unknown
      scope?: unknown
    }
    if (
      !isPluginCapabilityName(candidate.name)
      || seen.has(candidate.name)
      || (candidate.reason !== undefined
        && (typeof candidate.reason !== 'string' || candidate.reason.length > 4096))
      || (candidate.scope !== undefined
        && (
          !Array.isArray(candidate.scope)
          || candidate.scope.length > 128
          || candidate.scope.some(scope => {
            return typeof scope !== 'string' || scope.length > 4096
          })
        ))
    ) return false
    seen.add(candidate.name)
  }
  return true
}

/** A named action: appears in the Command Palette and optionally as a /slash command. */
export interface ExtensionCommandContrib {
  id: string
  title: string
  /** Show in the command palette (default true). */
  palette?: boolean
  /** Expose as a composer /slash command (the token after the slash). */
  slash?: string
  icon?: string
  category?: string
  /** Default keybinding, e.g. "mod+k c". User-rebindable. */
  keybinding?: string
  /** Focus/context predicate controlling availability. */
  when?: string
  /** What runs: a power-tier ipc method on this plugin, or a declared action name. */
  run?: { method?: string; action?: string }
}

/** Status-bar / footer item. */
export interface ExtensionFooterContrib {
  id: string
  entry?: string
  label?: string
  icon?: string
  render?: PluginRenderMode
  position?: 'left' | 'right'
  order?: number
}

/** A panel mounted in a host region (sidebar / bottom). */
export interface ExtensionPanelContrib {
  id: string
  title: string
  entry?: string
  icon?: string
  region?: 'left' | 'right' | 'bottom'
  render?: PluginRenderMode
  order?: number
}

export type ExtensionSettingControl =
  | { kind: 'toggle'; key: string; label: string; default?: boolean; description?: string }
  | { kind: 'text'; key: string; label: string; default?: string; placeholder?: string; description?: string }
  | { kind: 'number'; key: string; label: string; default?: number; min?: number; max?: number; step?: number; description?: string }
  | { kind: 'select'; key: string; label: string; default?: string; options: Array<{ value: string; label: string }>; description?: string }
  | { kind: 'button'; label: string; command: string; description?: string }

/** A settings section a plugin contributes to the Settings surface. */
export interface ExtensionSettingsSectionContrib {
  id: string
  title: string
  icon?: string
  order?: number
  items: ExtensionSettingControl[]
}

/** A named, reusable layout a plugin can register and users/agents can open. */
export interface ExtensionLayoutPresetContrib {
  id: string
  title: string
  icon?: string
  /** Reuses the existing LayoutTemplate tree shape (view kinds resolved via the registry). */
  layout: LayoutTemplateNode
}

/** A module that shapes the in-process agent runtime (guardrails / custom tools). */
export interface ExtensionAgentExtensionContrib {
  /** Path (relative to the plugin root) to the agent-extension entry module. */
  path: string
}

export interface ExtensionTileEntry {
  type: string
  label: string
  icon?: string
  entry: string
  defaultSize?: { w: number; h: number }
  minSize?: { w: number; h: number }
}

export interface ExtensionTileContrib extends ExtensionTileEntry {
  extId: string
  uiMode?: 'native' | 'custom'
  /** Sensitive browser media permissions declared by the owning extension. */
  sensitiveMedia?: import('./extension-sensitive-media.ts').SensitiveMediaCapability[]
  /** v2 render mode (iframe|component|mcp-ui); resolved from tier/ui.mode when absent. */
  render?: PluginRenderMode
}

export interface ExtensionChatSurfaceEntry {
  id: string
  label: string
  description?: string
  icon?: string
  entry: string
  /** What the surface produces when flushed. Defaults to 'image'. */
  emits?: 'image' | 'text'
  /** Preferred panel height in px when mounted above the composer. */
  defaultHeight?: number
  minHeight?: number
}

export interface ExtensionChatSurfaceContrib extends ExtensionChatSurfaceEntry {
  extId: string
  uiMode?: 'native' | 'custom'
}

export interface ExtensionMCPToolContrib {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ExtensionContextMenuContrib {
  label: string
  action: string
  tileType?: string
  extId?: string
}

export interface ExtensionSettingContrib {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean'
  default?: unknown
}

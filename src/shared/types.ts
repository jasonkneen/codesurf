export interface Workspace {
  id: string
  name: string
  /** Primary project folder for legacy callers. */
  path: string
  /** All project folders attached to this workspace/canvas tab. */
  projectPaths?: string[]
}

export interface ProjectRecord {
  id: string
  name: string
  path: string
}

export interface WorkspaceRecord {
  id: string
  name: string
  projectIds: string[]
  primaryProjectId?: string | null
}

export type ExecutionHostType = 'runtime' | 'local-daemon' | 'remote-daemon'
export type ExecutionMode = 'auto' | 'runtime-only' | 'prefer-local-daemon' | 'daemon-only' | 'specific-host'

export interface ExecutionHostRecord {
  id: string
  type: ExecutionHostType
  label: string
  enabled: boolean
  url?: string | null
  authToken?: string | null
}

export interface ExecutionPreference {
  mode: ExecutionMode
  hostId: string | null
}

export type BuiltinTileType = 'terminal' | 'note' | 'code' | 'image' | 'media' | 'kanban' | 'browser' | 'chat' | 'file' | 'files' | 'customisation'

// ─── Customisation Data Types ──────────────────────────────────────────────

export interface PromptTemplate {
  id: string
  name: string
  description: string
  template: string
  fields: PromptField[]
  tags: string[]
}

export interface PromptField {
  name: string
  type: 'str' | 'int' | 'float' | 'select' | 'multi-select'
  options?: string[]
  default?: string
  required: boolean
}

export interface SkillDefinition {
  id: string
  name: string
  description: string
  content: string
  command?: string
}

export interface AgentMode {
  id: string
  name: string
  description: string
  systemPrompt: string
  tools: string[] | null
  icon: string
  color: string
  isBuiltin: boolean
  defaultNextMode?: string
  /** Which tool this agent was discovered from: 'claude' | 'cursor' | 'opencode' | 'gemini' | etc. */
  source?: string
}
export type TileType = BuiltinTileType | `ext:${string}`

// ─── Tile Context Types ────────────────────────────────────────────────────

export interface TileContextEntry {
  key: string
  value: unknown
  updatedAt: number
  source: string
}

export interface ExtensionContextDeclaration {
  produces?: string[]
  consumes?: string[]
}

// ─── Layout Template Types ─────────────────────────────────────────────────

export interface LayoutTemplateSlot {
  tileType: TileType
  label?: string
}

export type LayoutTemplateNode =
  | { type: 'leaf'; slots: LayoutTemplateSlot[] }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; children: LayoutTemplateNode[]; sizes: number[] }

export interface LayoutTemplate {
  id: string
  name: string
  created_at: string
  tree: LayoutTemplateNode
}

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

export interface ExtensionManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  tier: 'safe' | 'power'
  ui?: ExtensionUIContrib
  contributes?: {
    tiles?: ExtensionTileEntry[]
    mcpTools?: ExtensionMCPToolContrib[]
    contextMenu?: ExtensionContextMenuContrib[]
    settings?: ExtensionSettingContrib[]
    actions?: ExtensionActionContrib[]
    context?: ExtensionContextDeclaration
  }
  main?: string
  permissions?: string[]
  _path?: string
  _enabled?: boolean
  _adapter?: string
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

// ─── Font Token System ──────────────────────────────────────────────────────
// VS Code-style granular font settings. Every token has family, size, lineHeight,
// weight, and letterSpacing. Users override only what they want in config.json.

export interface FontToken {
  family: string
  size: number
  lineHeight: number
  weight?: number
  letterSpacing?: number
}

/** Backward-compat alias */
export type FontConfig = FontToken

export interface FontSettings {
  /** Primary sans-serif — main UI text, headings, labels, chat messages */
  primary: FontToken
  /** Secondary sans-serif — metadata, subtitles, hints, smaller UI text */
  secondary: FontToken
  /** Monospace — terminal, code editor, inline code, data display */
  mono: FontToken

  // ── Legacy aliases (kept for backward compat with saved configs) ──
  /** @deprecated use primary */
  sans?: FontToken
  /** @deprecated use primary */
  title?: FontToken
  /** @deprecated use secondary */
  sectionLabel?: FontToken
  /** @deprecated use secondary */
  subtitle?: FontToken
  /** @deprecated use mono */
  terminal?: FontToken
  /** @deprecated use mono */
  codeEditor?: FontToken
  /** @deprecated use mono */
  inlineCode?: FontToken
  /** @deprecated use mono */
  commandPreview?: FontToken
  /** @deprecated use primary */
  chatMessage?: FontToken
  /** @deprecated use primary */
  chatInput?: FontToken
  /** @deprecated use secondary */
  chatToolbar?: FontToken
  /** @deprecated use mono */
  chatMeta?: FontToken
  /** @deprecated use mono */
  chatThinking?: FontToken
  /** @deprecated use primary */
  kanbanCardTitle?: FontToken
  /** @deprecated use secondary */
  kanbanBadge?: FontToken
  /** @deprecated use secondary */
  kanbanTab?: FontToken
  /** @deprecated use mono */
  dataUrl?: FontToken
  /** @deprecated use mono */
  dataPath?: FontToken
  /** @deprecated use mono */
  dataKeyValue?: FontToken
  /** @deprecated use mono */
  dataTimestamp?: FontToken
  /** @deprecated use mono */
  dataNumeric?: FontToken
  /** @deprecated use secondary */
  dataBadge?: FontToken
  /** @deprecated use secondary */
  button?: FontToken
  /** @deprecated use secondary */
  formLabel?: FontToken
  /** @deprecated use primary */
  formInput?: FontToken
  /** @deprecated use secondary */
  settingsHeader?: FontToken
  /** @deprecated use secondary */
  settingsLabel?: FontToken
}

// ── System font stacks ──────────────────────────────────────────────────────

const SANS_STACK = '"SF Pro Rounded", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
// Nerd Font variant kept at the front so terminal tiles render PUA icon
// glyphs. Everything after is main's modernized fallback ordering.
const MONO_STACK = '"FiraCode Nerd Font Mono", ui-monospace, "SF Mono", "Menlo", "Monaco", "JetBrains Mono", "Fira Code", monospace'

// ── Default font tokens ─────────────────────────────────────────────────────

export const DEFAULT_FONTS: FontSettings = {
  primary:   { family: SANS_STACK, size: 14, lineHeight: 1.10, weight: 400 },
  secondary: { family: SANS_STACK, size: 13, lineHeight: 1.00, weight: 400 },
  mono:      { family: MONO_STACK, size: 13, lineHeight: 1.00, weight: 500 },
}

/** Migrate old granular FontSettings to the simplified 3-token shape */
export function normalizeFontSettings(raw: Partial<FontSettings> | undefined): FontSettings {
  if (!raw) return { ...DEFAULT_FONTS }
  return {
    primary:   raw.primary ?? raw.sans ?? raw.chatMessage ?? DEFAULT_FONTS.primary,
    secondary: raw.secondary ?? raw.subtitle ?? raw.sectionLabel ?? DEFAULT_FONTS.secondary,
    mono:      raw.mono ?? raw.terminal ?? raw.codeEditor ?? DEFAULT_FONTS.mono,
  }
}

// ── AppSettings ─────────────────────────────────────────────────────────────

export interface AppSettings {
  // The three font tokens
  fonts: FontSettings
  // Legacy compat — mapped into fonts.* on load
  /** @deprecated use fonts.primary */
  primaryFont?: FontToken
  /** @deprecated use fonts.secondary */
  secondaryFont?: FontToken
  /** @deprecated use fonts.mono */
  monoFont?: FontToken
  // Theme / appearance
  /** UI chrome: dark palette, light palette, or follow OS (uses dark theme preset when OS is dark). */
  appearance: 'dark' | 'light' | 'system'
  themeId: string
  // Canvas
  canvasBackground: string
  canvasGlowEnabled: boolean
  canvasGlowRadius: number
  gridColorSmall: string
  gridColorLarge: string
  gridSpacingSmall: number
  gridSpacingLarge: number
  snapToGrid: boolean
  gridSize: number
  // Terminal (legacy — prefer fonts.mono)
  terminalFontSize: number
  terminalFontFamily: string
  // Appearance (legacy — prefer fonts.primary.size)
  uiFontSize: number
  /** @deprecated — translucency is always enabled at the Electron level now */
  translucentBackground: boolean
  /** Canvas background opacity: 1 = fully opaque, lower = more see-through vibrancy */
  translucentBackgroundOpacity: number
  // Behaviour
  autoSaveIntervalMs: number
  defaultTileSizes: Record<BuiltinTileType, { w: number; h: number }> & Record<string, { w: number; h: number }>
  // Chrome sync
  chromeSyncEnabled: boolean
  chromeSyncProfileDir: string | null
  // Where rendered links should open by default.
  linkOpenMode: 'browser-block' | 'external-browser'
  // Host-selection policy for chat and background execution.
  execution: ExecutionPreference
  // Local OpenAI-compat proxy endpoint remapping
  localProxyEnabled: boolean
  localProxyPort: number
  // Pinned extension entries used by the sidebar and canvas menu.
  // Values may be whole extension ids (pin all contributed blocks) or
  // specific extension tile types such as `ext:hq-email-list`.
  pinnedExtensionIds: string[]
  // Extensions hidden from the sidebar Extensions list (hidden = not in list)
  hiddenFromSidebarExtIds: string[]
  // Extensions shown as panels inside Settings
  settingsPanelExtIds: string[]
  // Master kill-switch: hide all extensions from sidebar and footer
  extensionsDisabled: boolean
}

export type ToolPermissionDecisionScope = 'once' | 'session' | 'today' | 'forever'

export interface ToolPermissionGrant {
  id: string
  provider: string
  toolName: string
  action: 'allow'
  scope: Exclude<ToolPermissionDecisionScope, 'once'>
  workspaceDir: string | null
  title?: string | null
  description?: string | null
  blockedPath?: string | null
  createdAt: string
  expiresAt?: string | null
}

export interface ToolPermissionStore {
  version: number
  grants: ToolPermissionGrant[]
}

export const DEFAULT_SETTINGS: AppSettings = {
  fonts: { ...DEFAULT_FONTS },
  appearance: 'dark',
  themeId: 'default-dark',
  canvasBackground: '#15171a',
  canvasGlowEnabled: true,
  canvasGlowRadius: 120,
  gridColorSmall: '#2a2e35',
  gridColorLarge: '#3a3f48',
  gridSpacingSmall: 20,
  gridSpacingLarge: 100,
  snapToGrid: true,
  gridSize: 20,
  terminalFontSize: 13,
  terminalFontFamily: MONO_STACK,
  uiFontSize: 12,
  translucentBackground: true,
  translucentBackgroundOpacity: 1,
  autoSaveIntervalMs: 500,
  defaultTileSizes: {
    terminal: { w: 600, h: 400 },
    code:     { w: 680, h: 500 },
    note:     { w: 500, h: 400 },
    image:    { w: 440, h: 360 },
    media:    { w: 640, h: 360 },
    kanban:   { w: 900, h: 560 },
    browser:  { w: 1000, h: 700 },
    chat:     { w: 420, h: 600 },
    file:     { w: 240, h: 240 },
    files:    { w: 280, h: 500 },
    customisation: { w: 720, h: 560 },
  },
  chromeSyncEnabled: false,
  chromeSyncProfileDir: null,
  linkOpenMode: 'browser-block',
  execution: {
    mode: 'auto',
    hostId: null,
  },
  localProxyEnabled: false,
  localProxyPort: 1337,
  pinnedExtensionIds: [],
  hiddenFromSidebarExtIds: [],
  settingsPanelExtIds: [],
  extensionsDisabled: false,
}

/** Deep-merge a single font token with its default */
function mergeToken(base: FontToken, override?: Partial<FontToken>): FontToken {
  if (!override) return { ...base }
  return { ...base, ...override }
}

/** Deep-merge all font tokens, falling back to defaults for any missing */
/** Merge saved font settings with defaults, handling legacy config migration */
function resolveFonts(saved?: Partial<FontSettings>, legacyPrimary?: Partial<FontToken>, legacySecondary?: Partial<FontToken>, legacyMono?: Partial<FontToken>): FontSettings {
  // Start with defaults
  const result: FontSettings = { ...DEFAULT_FONTS }

  // Apply legacy settings first (old configs had primaryFont/secondaryFont/monoFont)
  if (legacyPrimary) result.primary = mergeToken(result.primary, legacyPrimary)
  if (legacySecondary) result.secondary = mergeToken(result.secondary, legacySecondary)
  if (legacyMono) result.mono = mergeToken(result.mono, legacyMono)

  if (!saved) return result

  // Migrate old granular tokens: sans → primary, subtitle → secondary
  const s = saved as Record<string, Partial<FontToken> | undefined>
  const legacySans = s.sans ?? s.chatMessage ?? s.title
  const legacySub = s.subtitle ?? s.sectionLabel
  const legacyMonoToken = s.terminal ?? s.codeEditor

  if (legacySans && !saved.primary) result.primary = mergeToken(result.primary, legacySans)
  if (legacySub && !saved.secondary) result.secondary = mergeToken(result.secondary, legacySub)
  if (legacyMonoToken && !saved.mono) result.mono = mergeToken(result.mono, legacyMonoToken)

  // Apply new-style tokens (these win over everything)
  if (saved.primary) result.primary = mergeToken(result.primary, saved.primary)
  if (saved.secondary) result.secondary = mergeToken(result.secondary, saved.secondary)
  if (saved.mono) result.mono = mergeToken(result.mono, saved.mono)

  return result
}

export function withDefaultSettings(input: Partial<AppSettings> | null | undefined): AppSettings {
  const settings = input ?? {}
  const base: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...settings,
    execution: {
      ...DEFAULT_SETTINGS.execution,
      ...(settings.execution ?? {}),
    },
    defaultTileSizes: {
      ...DEFAULT_SETTINGS.defaultTileSizes,
      ...(settings.defaultTileSizes ?? {})
    },
    // Resolve fonts: new 3-token system, with legacy migration
    fonts: resolveFonts(
      settings.fonts as Partial<FontSettings>,
      settings.primaryFont as Partial<FontToken>,
      settings.secondaryFont as Partial<FontToken>,
      settings.monoFont as Partial<FontToken>,
    ),
  }
  base.canvasGlowRadius = Math.max(50, Math.min(200, base.canvasGlowRadius ?? DEFAULT_SETTINGS.canvasGlowRadius))
  return base
}

export interface Config {
  version: 2
  projects: ProjectRecord[]
  workspaces: WorkspaceRecord[]
  activeWorkspaceId: string | null
  settings: AppSettings
}

export interface TileState {
  id: string
  type: TileType
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  filePath?: string
  groupId?: string
  label?: string
  hideTitlebar?: boolean
  hideNavbar?: boolean
  borderRadius?: number
  launchBin?: string
  launchArgs?: string[]
}

const CURVIER_BLOCK_RADIUS_STEPS = [0, 3, 4, 6, 8, 12, 16, 24, 32, 40] as const

export function getCurvierBlockRadius(radius?: number): number {
  const current = Number.isFinite(radius) ? Math.max(0, Math.round(radius as number)) : 12
  if (current <= 0) return 0

  for (let index = 1; index < CURVIER_BLOCK_RADIUS_STEPS.length; index++) {
    const next = CURVIER_BLOCK_RADIUS_STEPS[index]
    if (current < next) return next
  }

  return current + 8
}

export interface GroupState {
  id: string
  label?: string
  color?: string
  parentGroupId?: string
  layoutMode?: boolean
  layout?: unknown  // PanelNode — typed as unknown to avoid circular import
  layoutBounds?: { x: number; y: number; w: number; h: number }
}

export interface LockedConnection {
  sourceTileId: string
  targetTileId: string
}

export interface CanvasState {
  tiles: TileState[]
  groups: GroupState[]
  viewport: { tx: number; ty: number; zoom: number }
  nextZIndex: number
  panelLayout?: unknown
  activePanelId?: string | null
  tabViewActive?: boolean
  expandedTileId?: string | null
  lockedConnections?: LockedConnection[]
}

// ─── Event Bus Types ────────────────────────────────────────────────────────

/** Event severity / category */
export type BusEventType =
  | 'progress'    // task progress update (percent, status text)
  | 'activity'    // log entry (terminal output, agent action)
  | 'task'        // task lifecycle (created, started, completed, failed)
  | 'notification'// alert / toast from any source
  | 'ask'         // agent asking for human input
  | 'answer'      // human responding to an ask
  | 'data'        // arbitrary structured data payload
  | 'system'      // internal bus events (subscribe, unsubscribe, error)

/** A single event on the bus */
export interface BusEvent {
  id: string
  channel: string          // e.g. "tile:abc123", "workspace:global", "agent:xyz"
  type: BusEventType
  source: string           // who published — tile ID, MCP tool name, "browser:postMessage", etc.
  timestamp: number
  payload: Record<string, unknown>
}

/** Subscription handle */
export interface BusSubscription {
  id: string
  channel: string          // supports wildcards: "tile:*", "*"
  subscriberId: string     // who subscribed — usually a tile ID
}

// ─── Activity Store Types ────────────────────────────────────────────────────

export type ActivityType = 'task' | 'tool' | 'skill' | 'context'
export type ActivityStatus = 'pending' | 'running' | 'done' | 'error' | 'paused'

/** A single activity record persisted per-workspace */
export interface ActivityRecord {
  id: string
  tileId: string
  workspaceId: string
  type: ActivityType
  status: ActivityStatus
  title: string
  detail?: string
  metadata?: Record<string, unknown>
  agent?: string
  createdAt: number
  updatedAt: number
}

/** Query filter for activity:query IPC */
export interface ActivityQuery {
  workspaceId: string
  tileId?: string
  type?: ActivityType
  status?: ActivityStatus
  agent?: string
  limit?: number
}

/** Channel metadata (optional, for UI display) */
export interface ChannelInfo {
  name: string             // human-readable label
  channel: string          // bus channel pattern
  unread: number           // unread event count for badge
  lastEvent?: BusEvent     // most recent event
}

// ─── Collab Protocol Types ──────────────────────────────────────────────────

/** A skill/tool available to an agent — toggleable from the drawer */
export interface SkillConfig {
  id: string
  name: string
  enabled: boolean
  source: 'builtin' | 'mcp' | 'workspace' | 'command'
  server?: string          // MCP server name (if source === 'mcp')
  description?: string
}

/** A context item dropped into the drawer — notes or reference files */
export interface ContextItem {
  id: string
  name: string
  type: 'note' | 'file'
  content?: string         // inline text (notes)
  path?: string            // filesystem path (files)
}

/** Per-tile collab state persisted to .collab/{tileId}/state.json */
export interface CollabState {
  tasks: CollabTask[]
  paused: boolean
  pausedAt?: number
}

/** A task within collab state — superset of what shows in the drawer */
export interface CollabTask {
  id: string
  title: string
  status: ActivityStatus
  createdAt: number
  updatedAt: number
  agent?: string
  detail?: string
}

/** Skills selection persisted to .collab/{tileId}/skills.json */
export interface CollabSkills {
  enabled: string[]
  disabled: string[]
}

export type CollabMailbox = 'inbox' | 'sent' | 'memory' | 'bin'
export type CollabMessageType = 'request' | 'reply' | 'note' | 'signal' | 'memory'
export type CollabMessageStatus = 'unread' | 'read' | 'sent' | 'archived'

export interface CollabMessageMeta {
  protocol: 'contex-message/v1'
  id: string
  threadId: string
  fromTileId: string
  toTileId: string
  type: CollabMessageType
  subject: string
  status: CollabMessageStatus
  createdAt: string
  createdTs: number
  updatedAt: string
  updatedTs: number
  replyToId?: string
}

export interface CollabMessage {
  mailbox: CollabMailbox
  filename: string
  meta: CollabMessageMeta
  body: string
  data?: Record<string, unknown>
}

export interface CollabMessageDraft {
  toTileId: string
  subject: string
  body: string
  type?: CollabMessageType
  threadId?: string
  replyToId?: string
  data?: Record<string, unknown>
}

export interface CollabMessageListItem {
  mailbox: CollabMailbox
  filename: string
  meta: CollabMessageMeta
}

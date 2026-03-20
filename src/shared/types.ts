export interface Workspace {
  id: string
  name: string
  path: string
}

export type TileType = 'terminal' | 'note' | 'code' | 'image' | 'kanban' | 'browser' | 'chat'

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
  // ── Base tokens (everything inherits from these if not overridden) ──
  /** Default sans-serif used across all UI */
  sans: FontToken
  /** Default monospace used for all code/data contexts */
  mono: FontToken

  // ── Headings & structure ──
  /** Tile title bars, panel headers */
  title: FontToken
  /** Section labels (ACTIVITY, BUILT-IN, MCP SERVERS, etc.) */
  sectionLabel: FontToken
  /** Secondary descriptions, subtitles, hints */
  subtitle: FontToken

  // ── Sidebar ──
  /** File/folder names in the sidebar tree */
  sidebarFileList: FontToken
  /** Section headers in sidebar (FILES, AGENTS, WORKSPACES) */
  sidebarHeader: FontToken
  /** Path breadcrumbs and workspace path */
  sidebarPath: FontToken

  // ── Terminal & code ──
  /** Terminal emulator (xterm) */
  terminal: FontToken
  /** Code editor (Monaco) */
  codeEditor: FontToken
  /** Inline code snippets, <code> tags */
  inlineCode: FontToken
  /** Launch commands, CLI previews */
  commandPreview: FontToken

  // ── Chat ──
  /** Chat message body text */
  chatMessage: FontToken
  /** Chat input textarea */
  chatInput: FontToken
  /** Model/provider dropdown labels */
  chatToolbar: FontToken
  /** Model IDs, cost data, session info */
  chatMeta: FontToken
  /** Thinking block content */
  chatThinking: FontToken

  // ── Kanban ──
  /** Kanban card titles */
  kanbanCardTitle: FontToken
  /** Agent pill badges, status pills */
  kanbanBadge: FontToken
  /** Tab labels (overview, terminal, notes) */
  kanbanTab: FontToken

  // ── Data display ──
  /** URLs, endpoints, server addresses */
  dataUrl: FontToken
  /** File paths, directory paths */
  dataPath: FontToken
  /** Key-value pairs (env vars, endpoints table) */
  dataKeyValue: FontToken
  /** Timestamps, dates */
  dataTimestamp: FontToken
  /** Numeric values, costs, counts */
  dataNumeric: FontToken
  /** Tags, chips, tool names */
  dataBadge: FontToken

  // ── Controls ──
  /** Buttons, clickable text actions */
  button: FontToken
  /** Form labels (URL, DESCRIPTION, etc.) */
  formLabel: FontToken
  /** Text inputs, selects */
  formInput: FontToken

  // ── Settings panel ──
  /** Settings section headers */
  settingsHeader: FontToken
  /** Settings field labels */
  settingsLabel: FontToken
}

// ── System font stacks ──────────────────────────────────────────────────────

const SANS_STACK = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
const MONO_STACK = '"JetBrains Mono", "Menlo", "Monaco", "SF Mono", "Fira Code", monospace'

// ── Default font tokens ─────────────────────────────────────────────────────

export const DEFAULT_FONTS: FontSettings = {
  // Base
  sans:             { family: SANS_STACK, size: 13, lineHeight: 1.5, weight: 400 },
  mono:             { family: MONO_STACK, size: 13, lineHeight: 1.5, weight: 400 },

  // Headings
  title:            { family: SANS_STACK, size: 14, lineHeight: 1.3, weight: 700 },
  sectionLabel:     { family: SANS_STACK, size: 9,  lineHeight: 1.2, weight: 700, letterSpacing: 1 },
  subtitle:         { family: SANS_STACK, size: 11, lineHeight: 1.4, weight: 400 },

  // Sidebar
  sidebarFileList:  { family: SANS_STACK, size: 12, lineHeight: 1.4, weight: 400 },
  sidebarHeader:    { family: SANS_STACK, size: 9,  lineHeight: 1.2, weight: 700, letterSpacing: 1 },
  sidebarPath:      { family: MONO_STACK, size: 10, lineHeight: 1.3, weight: 400 },

  // Terminal & code
  terminal:         { family: MONO_STACK, size: 13, lineHeight: 1.3, weight: 400 },
  codeEditor:       { family: MONO_STACK, size: 13, lineHeight: 1.5, weight: 400 },
  inlineCode:       { family: MONO_STACK, size: 12, lineHeight: 1.4, weight: 400 },
  commandPreview:   { family: MONO_STACK, size: 9,  lineHeight: 1.6, weight: 400 },

  // Chat
  chatMessage:      { family: SANS_STACK, size: 13, lineHeight: 1.5, weight: 400 },
  chatInput:        { family: SANS_STACK, size: 13, lineHeight: 1.5, weight: 400 },
  chatToolbar:      { family: SANS_STACK, size: 11, lineHeight: 1.2, weight: 400 },
  chatMeta:         { family: MONO_STACK, size: 10, lineHeight: 1.3, weight: 400 },
  chatThinking:     { family: MONO_STACK, size: 11, lineHeight: 1.5, weight: 400 },

  // Kanban
  kanbanCardTitle:  { family: SANS_STACK, size: 13, lineHeight: 1.3, weight: 600 },
  kanbanBadge:      { family: SANS_STACK, size: 9,  lineHeight: 1.2, weight: 400 },
  kanbanTab:        { family: SANS_STACK, size: 11, lineHeight: 1.2, weight: 400 },

  // Data display
  dataUrl:          { family: MONO_STACK, size: 10, lineHeight: 1.3, weight: 400 },
  dataPath:         { family: MONO_STACK, size: 10, lineHeight: 1.3, weight: 400 },
  dataKeyValue:     { family: MONO_STACK, size: 10, lineHeight: 1.3, weight: 400 },
  dataTimestamp:    { family: MONO_STACK, size: 9,  lineHeight: 1.2, weight: 400 },
  dataNumeric:      { family: MONO_STACK, size: 10, lineHeight: 1.3, weight: 400 },
  dataBadge:        { family: SANS_STACK, size: 9,  lineHeight: 1.2, weight: 400 },

  // Controls
  button:           { family: SANS_STACK, size: 10, lineHeight: 1.2, weight: 400 },
  formLabel:        { family: SANS_STACK, size: 9,  lineHeight: 1.2, weight: 400, letterSpacing: 0.5 },
  formInput:        { family: SANS_STACK, size: 11, lineHeight: 1.4, weight: 400 },

  // Settings panel
  settingsHeader:   { family: SANS_STACK, size: 9,  lineHeight: 1.2, weight: 700, letterSpacing: 1 },
  settingsLabel:    { family: SANS_STACK, size: 11, lineHeight: 1.4, weight: 400 },
}

// ── AppSettings ─────────────────────────────────────────────────────────────

export interface AppSettings {
  // Granular font tokens (VS Code-style: override any subset in config.json)
  fonts: FontSettings
  // Legacy compat — still read by SettingsPanel pickers, mapped into fonts.*
  primaryFont: FontToken
  secondaryFont: FontToken
  monoFont: FontToken
  // Canvas
  canvasBackground: string
  gridColorSmall: string
  gridColorLarge: string
  gridSpacingSmall: number
  gridSpacingLarge: number
  snapToGrid: boolean
  gridSize: number
  // Terminal (legacy — prefer fonts.terminal)
  terminalFontSize: number
  terminalFontFamily: string
  // Appearance (legacy — prefer fonts.sans.size)
  uiFontSize: number
  // Sidebar
  sidebarDefaultSort: 'name' | 'type' | 'ext'
  sidebarIgnored: string[]
  // Behaviour
  autoSaveIntervalMs: number
  defaultTileSizes: Record<TileType, { w: number; h: number }>
}

export const DEFAULT_SETTINGS: AppSettings = {
  fonts: { ...DEFAULT_FONTS },
  primaryFont: { family: SANS_STACK, size: 14, lineHeight: 1.5 },
  secondaryFont: { family: '"SF Pro Display", "Segoe UI", "Helvetica Neue", sans-serif', size: 12, lineHeight: 1.4 },
  monoFont: { family: MONO_STACK, size: 13, lineHeight: 1.5 },
  canvasBackground: '#1e1e1e',
  gridColorSmall: '#333333',
  gridColorLarge: '#4a4a4a',
  gridSpacingSmall: 20,
  gridSpacingLarge: 100,
  snapToGrid: true,
  gridSize: 20,
  terminalFontSize: 13,
  terminalFontFamily: MONO_STACK,
  uiFontSize: 12,
  sidebarDefaultSort: 'name',
  sidebarIgnored: ['.git', 'node_modules', '.next', 'dist', 'dist-electron', '.DS_Store', '__pycache__', '.cache', 'out'],
  autoSaveIntervalMs: 500,
  defaultTileSizes: {
    terminal: { w: 600, h: 400 },
    code:     { w: 680, h: 500 },
    note:     { w: 500, h: 400 },
    image:    { w: 440, h: 360 },
    kanban:   { w: 900, h: 560 },
    browser:  { w: 1000, h: 700 },
    chat:     { w: 420, h: 600 },
  }
}

/** Deep-merge a single font token with its default */
function mergeToken(base: FontToken, override?: Partial<FontToken>): FontToken {
  if (!override) return { ...base }
  return { ...base, ...override }
}

/** Deep-merge all font tokens, falling back to defaults for any missing */
function mergeFonts(base: FontSettings, overrides?: Partial<Record<keyof FontSettings, Partial<FontToken>>>): FontSettings {
  if (!overrides) return { ...base }
  const result = { ...base }
  for (const key of Object.keys(base) as (keyof FontSettings)[]) {
    result[key] = mergeToken(base[key], overrides[key])
  }
  return result
}

/** Apply legacy primaryFont/monoFont overrides to the granular font tokens.
 *  When a user changes primaryFont in the settings UI, all sans-based tokens
 *  pick up the new family. Same for monoFont → all mono-based tokens. */
function applyLegacyFontOverrides(fonts: FontSettings, primary?: Partial<FontToken>, mono?: Partial<FontToken>): FontSettings {
  if (!primary && !mono) return fonts
  const result = { ...fonts }
  const pFamily = primary?.family
  const mFamily = mono?.family

  // All tokens that should track primaryFont (sans-based)
  const sansKeys: (keyof FontSettings)[] = [
    'sans', 'title', 'sectionLabel', 'subtitle',
    'sidebarFileList', 'sidebarHeader',
    'chatMessage', 'chatInput', 'chatToolbar',
    'kanbanCardTitle', 'kanbanBadge', 'kanbanTab',
    'dataBadge', 'button', 'formLabel', 'formInput',
    'settingsHeader', 'settingsLabel',
  ]
  // All tokens that should track monoFont (mono-based)
  const monoKeys: (keyof FontSettings)[] = [
    'mono', 'sidebarPath', 'terminal', 'codeEditor', 'inlineCode', 'commandPreview',
    'chatMeta', 'chatThinking',
    'dataUrl', 'dataPath', 'dataKeyValue', 'dataTimestamp', 'dataNumeric',
  ]

  if (pFamily) {
    for (const k of sansKeys) result[k] = { ...result[k], family: pFamily }
  }
  if (mFamily) {
    for (const k of monoKeys) result[k] = { ...result[k], family: mFamily }
  }
  return result
}

export function withDefaultSettings(input: Partial<AppSettings> | null | undefined): AppSettings {
  const settings = input ?? {}
  const base: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...settings,
    primaryFont: { ...DEFAULT_SETTINGS.primaryFont, ...(settings.primaryFont ?? {}) },
    secondaryFont: { ...DEFAULT_SETTINGS.secondaryFont, ...(settings.secondaryFont ?? {}) },
    monoFont: { ...DEFAULT_SETTINGS.monoFont, ...(settings.monoFont ?? {}) },
    sidebarIgnored: settings.sidebarIgnored ?? DEFAULT_SETTINGS.sidebarIgnored,
    defaultTileSizes: {
      ...DEFAULT_SETTINGS.defaultTileSizes,
      ...(settings.defaultTileSizes ?? {})
    },
    fonts: mergeFonts(DEFAULT_FONTS, settings.fonts as Partial<Record<keyof FontSettings, Partial<FontToken>>>),
  }
  // If user set granular fonts.*, those win. Otherwise legacy primaryFont/monoFont
  // cascade into the token set so the settings UI pickers still work.
  if (!settings.fonts) {
    base.fonts = applyLegacyFontOverrides(base.fonts, settings.primaryFont, settings.monoFont)
  }
  return base
}

export interface Config {
  workspaces: Workspace[]
  activeWorkspaceIndex: number
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
}

export interface GroupState {
  id: string
  label?: string
  color?: string
  parentGroupId?: string
}

export interface CanvasState {
  tiles: TileState[]
  groups: GroupState[]
  viewport: { tx: number; ty: number; zoom: number }
  nextZIndex: number
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
  source: 'builtin' | 'mcp'
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

// ─── Barrel re-exports for backward compatibility ──────────────────────────
// All domain modules are re-exported so existing `import { X } from './types'`
// continues to work unchanged.

export * from './activity-types.ts'
export * from './canvas-utils.ts'
export * from './collab-types.ts'
export * from './dreaming-types.ts'
export * from './event-bus-types.ts'
export * from './execution-types.ts'
export * from './extension-types.ts'
export * from './pet-types.ts'
export * from './settings-runtime.ts'
export * from './workspace-types.ts'

// ─── Core tile / canvas / permission types ─────────────────────────────────

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
  /**
   * OPTIONAL hard model/provider requirement (P1b-2, precedence layer 1). When a
   * persona LINKS a skill that declares `requiredModel`, selecting that persona
   * PINS the composer's model (+ provider, if given) and DISABLES the picker —
   * an outer resolver (resolveSkillModelLock) runs ABOVE the soft default.
   *
   * Like a persona's soft binding, this is NOT a security boundary: it only
   * drives renderer model-resolution + composer disablement; it never flows
   * through resolveAuthoritativeAgentMode (the trusted-disk tools/permission path).
   */
  requiredModel?: string
  /** OPTIONAL provider to pin alongside `requiredModel`. */
  requiredProvider?: string
}

/**
 * A persona's preferred engine/model binding. This is a SOFT default only — it
 * SEEDS the composer's provider/model when the persona is selected; the user can
 * always override it (see resolvePersonaModelSeed + the precedence ladder below).
 *
 * Model is deliberately NOT a security boundary: unlike `tools`, a binding never
 * flows through the authoritative trusted-disk resolver (resolveAuthoritativeAgentMode)
 * — that path stays exclusively for tools/permissions and fully fail-closed.
 *
 * DESIGN-FOR-N (P1b): the shape is intentionally an object (not bare scalars) so
 * later phases can grow it WITHOUT reshaping callers:
 *   - P1b-2 will add a hard skill-lock (e.g. `lockedBySkill?: string`) here, read
 *     by an outer resolver ABOVE the soft layer.
 *   - a future multi-binding model can add `bindings?: PersonaBinding[]` alongside
 *     `defaultBinding` on Persona.
 */
export interface PersonaBinding {
  /** Preferred provider id (e.g. 'claude' | 'codex' | 'hermes'). */
  provider?: string
  /** Preferred model id within that provider. */
  model?: string
}

export interface Persona {
  id: string
  name: string
  description: string
  /** The persona's "soul": its system prompt. */
  systemPrompt: string
  tools: string[] | null
  icon: string
  color: string
  isBuiltin: boolean
  defaultNextMode?: string
  /**
   * OPTIONAL soft engine/model default. Seeds the composer's provider/model when
   * this persona is selected; never a hard lock, never a permission boundary.
   * Unset (the default for all built-ins) = no preference → composer unchanged.
   */
  defaultBinding?: PersonaBinding
  /**
   * Optional base-persona id to inherit from. Resolution merges the base, then
   * overlays this persona's explicitly-defined fields. Fail-closed tool rule: if
   * this persona defines `tools`, its list wins outright; if it omits `tools`, it
   * inherits the base's. Inheritance never widens tools beyond the child's grant.
   * See overlayPersonas() in src/shared/agentModes.ts.
   */
  extends?: string
  /**
   * OPTIONAL linked skill references (P1b-2, precedence layer 1). Each entry
   * matches a workspace skill by `id` OR `name`. If the FIRST linked skill that
   * declares a `requiredModel` is found, selecting this persona HARD-locks the
   * composer's model/provider and disables the picker (see resolveSkillModelLock).
   *
   * Built-ins carry NO skills (keeps DEFAULT_PERSONAS byte-identical across the
   * shared<->daemon drift guard). Like `defaultBinding`, this is display/composer
   * data only — never a permission boundary.
   */
  skills?: string[]
  /** Which tool this persona was discovered from: 'claude' | 'cursor' | 'opencode' | 'gemini' | etc. */
  source?: string
}

/**
 * @deprecated Renamed to {@link Persona}. This alias is retained so the many
 * existing `AgentMode` references (and the wire field `ChatRequest.agentMode`)
 * keep compiling during/after the Persona rename. Prefer `Persona` in new code.
 */
export type AgentMode = Persona
export type TileType = BuiltinTileType | `ext:${string}`

// ─── Tile Context Types ────────────────────────────────────────────────────

export interface TileContextEntry {
  key: string
  value: unknown
  updatedAt: number
  source: string
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

// ─── Permission Types ──────────────────────────────────────────────────────

// All possible scopes the user can pick in the permission card.
// - once    : one-shot...
// - session : persist allow for the current in-memory session
// - today   : persist allow until end of local day
// - forever : persist allow permanently (across restarts)
// - never   : persist deny permanently — the tool is silently denied next
//             time without re-prompting. Mirrors `forever` but for deny.
export type ToolPermissionDecisionScope = 'once' | 'session' | 'today' | 'forever' | 'never'

export interface ToolPermissionGrant {
  id: string
  provider: string
  toolName: string
  // `allow` grants silently auto-approve on match; `deny` grants silently
  // auto-reject. Only the latter is created for the `never` scope.
  action: 'allow' | 'deny'
  scope: Exclude<ToolPermissionDecisionScope, 'once'>
  workspaceDir: string | null
  /**
   * The specific resource this grant covers — the tile id for tools that act on
   * one tile, such as terminal_send_input.
   *
   * Without it the grant key was (provider, toolName, workspaceDir) while the
   * dialog said "wants to type into terminal tile <id>": approving "Always" for
   * terminal A silently authorised every terminal in the workspace, including
   * for a prompt-injected agent in another tile and for the raw /inject route
   * that shares the same toolName and scope. Absent = a workspace-wide grant,
   * which stays correct for tools that are not tile-scoped.
   */
  resourceId?: string | null
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

// ─── Canvas State Types ────────────────────────────────────────────────────

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
  // Set/read at runtime by App.tsx's auto-agent discovery loop (it writes
  // `autoAgentMode: true/false` onto tiles and reads `tile.autoAgentMode`), but
  // was never declared here — so the reads at App.tsx:4093/5198 were typed as a
  // non-existent property. Declared to match the established runtime behavior.
  autoAgentMode?: boolean
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
  /** A non-layout group expanded as a fullscreen sub-canvas. Members remain freely positioned. */
  expandedCanvasGroupId?: string | null
  /** Layout group currently shown as the fullscreen / tab arrangement. */
  expandLayoutGroupId?: string | null
  /** Viewport snapshot to restore when exiting expandedCanvasGroupId. */
  expandedCanvasPriorViewport?: { tx: number; ty: number; zoom: number } | null
  lockedConnections?: LockedConnection[]
}

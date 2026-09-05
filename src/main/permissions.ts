import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { randomUUID } from 'node:crypto'
import type { ToolPermissionDecisionScope, ToolPermissionGrant, ToolPermissionStore } from '../shared/types'
import { CODESURF_HOME } from './paths'

const PERMISSIONS_PATH = join(CODESURF_HOME, 'permissions.json')
const PERMISSIONS_VERSION = 1

const sessionGrants = new Map<string, ToolPermissionGrant>()

export interface ToolPermissionRequest {
  provider: string
  toolName: string
  title?: string | null
  description?: string | null
  blockedPath?: string | null
  workspaceDir?: string | null
  /** Tile id (or other single resource) this request is scoped to, when it is. */
  resourceId?: string | null
}

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true })
}

function atomicWriteJson(filePath: string, value: unknown): void {
  ensureDir(dirname(filePath))
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  // 0o600: permission grants are user-scoped; do not leave them world-readable.
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tempPath, filePath)
}

function normalizeWorkspaceDir(workspaceDir?: string | null): string | null {
  const trimmed = String(workspaceDir ?? '').trim()
  if (!trimmed) return null
  try {
    return resolve(trimmed)
  } catch {
    return trimmed
  }
}

function normalizeStore(raw: unknown): ToolPermissionStore {
  const grants = Array.isArray((raw as ToolPermissionStore | null)?.grants)
    ? (raw as ToolPermissionStore).grants.filter((grant): grant is ToolPermissionGrant => {
        return Boolean(
          grant
          && typeof grant.id === 'string'
          && grant.id
          && typeof grant.provider === 'string'
          && grant.provider
          && typeof grant.toolName === 'string'
          && grant.toolName
          && (grant.action === 'allow' || grant.action === 'deny')
          && (grant.scope === 'session' || grant.scope === 'today' || grant.scope === 'forever' || grant.scope === 'never')
          && typeof grant.createdAt === 'string'
        )
      })
    : []

  // MCP grants are always workspace-scoped. A legacy null-workspace MCP grant
  // is a global capability and must not survive a read/migration, otherwise it
  // can authorize an unrelated workspace before the caller's scope is known.
  const scopedMcpGrants = grants.filter(grant => (
    grant.provider.trim().toLowerCase() !== 'mcp'
    || normalizeWorkspaceDir(grant.workspaceDir) !== null
  ))

  return {
    version: PERMISSIONS_VERSION,
    grants: scopedMcpGrants,
  }
}

function readPersistedStore(): ToolPermissionStore {
  try {
    const raw = JSON.parse(readFileSync(PERMISSIONS_PATH, 'utf8'))
    const normalized = normalizeStore(raw)
    const rawGrants = Array.isArray(raw?.grants) ? raw.grants : []
    if (normalized.grants.length !== rawGrants.length) {
      writePersistedStore(normalized)
    }
    return normalized
  } catch {
    return { version: PERMISSIONS_VERSION, grants: [] }
  }
}

function writePersistedStore(store: ToolPermissionStore): void {
  atomicWriteJson(PERMISSIONS_PATH, store)
}

function isGrantExpired(grant: ToolPermissionGrant): boolean {
  if (!grant.expiresAt) return false
  const expiry = Date.parse(grant.expiresAt)
  return Number.isFinite(expiry) && expiry <= Date.now()
}

function pruneExpiredPersistedGrants(store: ToolPermissionStore): ToolPermissionStore {
  const next = {
    ...store,
    grants: store.grants.filter(grant => !isGrantExpired(grant)),
  }
  if (next.grants.length !== store.grants.length) {
    writePersistedStore(next)
  }
  return next
}

function purgeExpiredSessionGrants(): void {
  for (const [key, grant] of sessionGrants.entries()) {
    if (isGrantExpired(grant)) sessionGrants.delete(key)
  }
}

function makeGrantId(): string {
  return `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function endOfTodayIso(): string {
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  return end.toISOString()
}

function sameGrantTarget(grant: ToolPermissionGrant, request: ToolPermissionRequest): boolean {
  if (grant.provider !== request.provider) return false
  if (grant.toolName !== request.toolName) return false
  const requestedWorkspace = normalizeWorkspaceDir(request.workspaceDir)
  if (request.provider.trim().toLowerCase() === 'mcp' && requestedWorkspace === null) return false
  if ((grant.resourceId ?? null) !== (request.resourceId ?? null)) return false
  return (grant.workspaceDir ?? null) === requestedWorkspace
}

function grantAppliesToRequest(grant: ToolPermissionGrant, request: ToolPermissionRequest): boolean {
  if (grant.provider !== request.provider) return false
  if (grant.toolName !== request.toolName) return false
  // A resource-scoped grant covers only that resource. A legacy grant with no
  // resourceId stays workspace-wide, but a request that names a resource must
  // not be satisfied by one — otherwise "Always" for terminal A would keep
  // authorising terminal B exactly as before.
  const grantResource = grant.resourceId ?? null
  const requestResource = request.resourceId ?? null
  if (requestResource !== null && grantResource !== requestResource) return false
  if (grantResource !== null && grantResource !== requestResource) return false
  const grantWorkspace = normalizeWorkspaceDir(grant.workspaceDir)
  const requestWorkspace = normalizeWorkspaceDir(request.workspaceDir)
  if (grant.provider.trim().toLowerCase() === 'mcp') {
    return grantWorkspace !== null && requestWorkspace !== null && grantWorkspace === requestWorkspace
  }
  if (grantWorkspace === null) return true
  return grantWorkspace === requestWorkspace
}

function buildGrant(request: ToolPermissionRequest, scope: Exclude<ToolPermissionDecisionScope, 'once'>): ToolPermissionGrant {
  // `never` is the only deny-scope for now; every other scope is an allow.
  const action: 'allow' | 'deny' = scope === 'never' ? 'deny' : 'allow'
  return {
    id: makeGrantId(),
    provider: request.provider,
    toolName: request.toolName,
    action,
    scope,
    workspaceDir: normalizeWorkspaceDir(request.workspaceDir),
    resourceId: request.resourceId ?? null,
    title: request.title ?? null,
    description: request.description ?? null,
    blockedPath: request.blockedPath ?? null,
    createdAt: new Date().toISOString(),
    expiresAt: scope === 'today' ? endOfTodayIso() : null,
  }
}

export function persistGrant(request: ToolPermissionRequest, scope: Exclude<ToolPermissionDecisionScope, 'once' | 'session'>): ToolPermissionGrant {
  const store = pruneExpiredPersistedGrants(readPersistedStore())
  const nextGrant = buildGrant(request, scope)
  const filtered = store.grants.filter(grant => !sameGrantTarget(grant, request))
  const nextStore = { ...store, grants: [nextGrant, ...filtered] }
  writePersistedStore(nextStore)
  return nextGrant
}

export function storeSessionGrant(request: ToolPermissionRequest): ToolPermissionGrant {
  const nextGrant = buildGrant(request, 'session')
  const key = `${nextGrant.provider}::${nextGrant.toolName}::${nextGrant.workspaceDir ?? ''}`
  sessionGrants.set(key, nextGrant)
  return nextGrant
}

export function listPermissionGrants(): ToolPermissionGrant[] {
  purgeExpiredSessionGrants()
  const persisted = pruneExpiredPersistedGrants(readPersistedStore()).grants
  const session = Array.from(sessionGrants.values())
  return [...session, ...persisted].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

export function clearPermissionGrant(id: string): ToolPermissionGrant[] {
  for (const [key, grant] of sessionGrants.entries()) {
    if (grant.id === id) {
      sessionGrants.delete(key)
    }
  }

  const store = readPersistedStore()
  const nextStore = {
    ...store,
    grants: store.grants.filter(grant => grant.id !== id),
  }
  if (nextStore.grants.length !== store.grants.length) {
    writePersistedStore(nextStore)
  }

  return listPermissionGrants()
}

export function clearAllPermissionGrants(): ToolPermissionGrant[] {
  sessionGrants.clear()
  writePersistedStore({ version: PERMISSIONS_VERSION, grants: [] })
  return []
}

/**
 * Tri-state lookup of any standing decision for this request.
 * Returns the grant's `action` ('allow' | 'deny') if a matching grant
 * exists, else `null` meaning "ask the user".
 *
 * Session grants take precedence over persisted grants (so a per-session
 * deny can temporarily override a global allow, etc.). Within a scope,
 * the first match wins — order is sessionGrants insertion order, then
 * persisted grants as stored (newest-first thanks to `persistGrant`
 * prepending).
 */
export function resolveStoredPermission(request: ToolPermissionRequest): 'allow' | 'deny' | null {
  purgeExpiredSessionGrants()
  const persisted = pruneExpiredPersistedGrants(readPersistedStore()).grants
  const grant = [...sessionGrants.values(), ...persisted].find(candidate => grantAppliesToRequest(candidate, request))
  if (!grant) return null
  return grant.action
}

/**
 * Convenience boolean form for call sites that only care whether the tool
 * is explicitly allowed (i.e. treat "no grant" the same as "deny grant"
 * → caller must prompt / fall back). Preserved so call-sites that
 * short-circuit on an allow can stay compact.
 */
export function hasStoredAllow(request: ToolPermissionRequest): boolean {
  return resolveStoredPermission(request) === 'allow'
}

async function promptForPermission(request: ToolPermissionRequest): Promise<ToolPermissionDecisionScope | 'deny'> {
  const detailLines = [
    request.description?.trim() || '',
    request.blockedPath ? `Path: ${request.blockedPath}` : '',
    normalizeWorkspaceDir(request.workspaceDir) ? `Workspace: ${normalizeWorkspaceDir(request.workspaceDir)}` : '',
  ].filter(Boolean)

  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed()) ?? null
  const dialogOptions: MessageBoxOptions = {
    type: 'question',
    // Order is significant — `response` index is used below. "Never" sits
    // next to "Deny" since both are negative decisions; the rest are
    // scopes of positive approval.
    buttons: ['Deny', 'Never', 'Allow Once', 'This Session', 'All Day', 'Always'],
    // Deny is the default: this modal is agent-initiated, so the
    // Return-activated button must not be an approval. A stack of prompts
    // cleared with repeated Return presses would otherwise grant each one —
    // for terminal_send_input that is shell-command injection into a live
    // terminal. Matches security/permissionBoundary.ts, which defaults to Deny.
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Tool Permission',
    message: request.title?.trim() || `${request.provider} wants to run ${request.toolName}`,
    detail: detailLines.join('\n'),
  }
  const { response } = win
    ? await dialog.showMessageBox(win, dialogOptions)
    : await dialog.showMessageBox(dialogOptions)

  switch (response) {
    case 1: return 'never'
    case 2: return 'once'
    case 3: return 'session'
    case 4: return 'today'
    case 5: return 'forever'
    default: return 'deny'
  }
}

/**
 * Detailed outcome of a permission request — exposes the persisted scope
 * so callers like the OpenCode bridge can translate `forever` into the
 * SDK's native `"always"` reply rather than a misleading `"once"`.
 */
export interface ToolPermissionOutcome {
  allowed: boolean
  /**
   * The scope under which the decision was made. `once` for a transient
   * allow, `never` for a transient deny's persistent cousin, etc.
   * `undefined` when the short-circuit path took over (stored grant or
   * non-interactive deny) — inspect `allowed` in that case.
   */
  scope?: ToolPermissionDecisionScope
  /**
   * True when the decision came from a pre-existing grant rather than a
   * fresh user prompt. Lets callers skip UX like success toasts.
   */
  fromStored?: boolean
}

/**
 * Resolve a permission decision for a pending tool call.
 *
 * Ordering:
 *   1. Stored allow grant  → allow (no prompt)
 *   2. Stored deny  grant  → deny  (no prompt)
 *   3. interactive=false   → deny  (background/relay path)
 *   4. Prompt user, honour the choice, persist the appropriate scope.
 */
export async function requestToolPermissionDetailed(
  request: ToolPermissionRequest,
  interactive: boolean,
): Promise<ToolPermissionOutcome> {
  // MCP callers can cross tile boundaries. Never let a missing workspace
  // authority fall through to the legacy null-workspace/global grant scope.
  if (request.provider.trim().toLowerCase() === 'mcp' && !normalizeWorkspaceDir(request.workspaceDir)) {
    return { allowed: false }
  }
  const stored = resolveStoredPermission(request)
  if (stored === 'allow') return { allowed: true, fromStored: true }
  if (stored === 'deny') return { allowed: false, fromStored: true }
  if (!interactive) return { allowed: false }

  const decision = await promptForPermission(request)
  if (decision === 'deny') return { allowed: false, scope: undefined }
  if (decision === 'never') {
    persistGrant(request, 'never')
    return { allowed: false, scope: 'never' }
  }
  if (decision === 'session') {
    storeSessionGrant(request)
  } else if (decision === 'today' || decision === 'forever') {
    persistGrant(request, decision)
  }
  return { allowed: true, scope: decision }
}

/**
 * Back-compat boolean wrapper. New code should prefer
 * `requestToolPermissionDetailed` so it can map scopes to provider-native
 * replies (e.g. OpenCode's `'always'`).
 */
export async function requestToolPermission(request: ToolPermissionRequest, interactive: boolean): Promise<boolean> {
  return (await requestToolPermissionDetailed(request, interactive)).allowed
}

export function getPermissionsStorePath(): string {
  if (!existsSync(dirname(PERMISSIONS_PATH))) ensureDir(dirname(PERMISSIONS_PATH))
  return PERMISSIONS_PATH
}

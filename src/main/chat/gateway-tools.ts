/**
 * Pure helpers for the AI Gateway provider's tool loop and model listing.
 *
 * Electron-free (type-only imports) so `node --test` can import it directly
 * under type-stripping, mirroring agent-mode-tools.ts. The gateway provider
 * executes the canvas MCP toolset in-process; these helpers decide WHICH
 * tools a turn may use (Persona allow-list semantics from agent-mode-tools)
 * and normalize the gateway's model metadata for the renderer picker.
 */

import { normalizeToolName } from './agent-mode-tools.ts'

/** Secrets-store name for the AI Gateway API key. Lives here (not in the
 * provider) so lightweight importers like the daemon spawn manager don't pull
 * the full chat runtime and create a module cycle. */
export const GATEWAY_SECRET_NAME = 'ai-gateway'

/**
 * Single source of truth for AI Gateway key precedence: the stored secret wins,
 * the environment is the fallback.
 *
 * This exists because the app and the daemon spawn path had OPPOSITE ordering
 * (app: secret then env; daemon: env then secret). With both configured, an
 * in-app turn and a daemon-executed job would authenticate as different
 * accounts — split billing and "works in the app, fails in the daemon" bugs
 * that are near-impossible to diagnose from the UI.
 *
 * Stored-secret-first is the correct direction: Settings → Providers is where
 * the user is told the key lives, so a key saved there must take effect even if
 * a stale AI_GATEWAY_API_KEY is exported in the launching shell.
 *
 * Takes the stored value as an argument rather than importing the secrets store
 * so this module stays Electron-free and unit-testable under node --test.
 */
export function resolveGatewayApiKey(
  storedSecret: string | null | undefined,
  // Index signature (not a named optional field) so process.env assigns
  // cleanly — a weak type with only optional members is rejected against
  // ProcessEnv under tsc's weak-type check.
  env: { readonly [key: string]: string | undefined } = {},
): string | null {
  const stored = typeof storedSecret === 'string' ? storedSecret.trim() : ''
  if (stored) return stored
  const fromEnv = typeof env.AI_GATEWAY_API_KEY === 'string' ? env.AI_GATEWAY_API_KEY.trim() : ''
  return fromEnv || null
}

/** Error surfaced when a gateway turn cannot be bound to a specific tile. */
export const GATEWAY_PRINCIPAL_UNRESOLVED_ERROR =
  'Chat identity unresolved: this turn has no workspace/tile binding, so canvas tools cannot be scoped safely.'

/**
 * Resolve the MCP principal for a gateway chat turn, or null when the turn
 * cannot be bound to a tile.
 *
 * Returning null (rather than falling back to `{ kind: 'global' }`) is the
 * whole point. `assertTileScope` treats a global principal as authorized for
 * every workspace and tile, and mcp-server.ts documents it as "trusted UI
 * state, not an agent credential". Every other provider derives its principal
 * from a tile TOKEN via resolvePrincipal, so a missing binding fails closed
 * there by construction; the gateway builds one from request fields instead,
 * so it has to fail closed explicitly.
 */
export function resolveGatewayPrincipal(
  workspaceId: unknown,
  tileId: unknown,
): { kind: 'tile'; workspaceId: string; tileId: string } | null {
  const ws = typeof workspaceId === 'string' ? workspaceId.trim() : ''
  const tile = typeof tileId === 'string' ? tileId.trim() : ''
  if (!ws || !tile) return null
  return { kind: 'tile', workspaceId: ws, tileId: tile }
}

export interface GatewayToolSchema {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

// Apply AgentMode.tools allow-list semantics to the MCP toolset:
//   null  → unrestricted (full toolset)
//   []    → explicit deny-all (no tools)
//   names → restricted to those tool names (normalized comparison, so a
//           Claude-style "CanvasCreateTile" matches "canvas_create_tile")
export function selectGatewayTools(
  all: GatewayToolSchema[],
  allowList: string[] | null,
): GatewayToolSchema[] {
  if (allowList == null) return all
  if (allowList.length === 0) return []
  const allowed = new Set(allowList.map(normalizeToolName))
  return all.filter(tool => allowed.has(normalizeToolName(tool.name)))
}

export interface GatewayModelEntry {
  id: string
  name: string
  description?: string | null
  modelType?: string | null
  pricing?: { input: string; output: string } | null
}

export interface GatewayModelOption {
  id: string
  label: string
  description?: string
}

// Format a per-token USD price as $/1M tokens ("$3/M in · $15/M out").
function formatPricing(pricing: GatewayModelEntry['pricing']): string | null {
  if (!pricing) return null
  const perMillion = (raw: string): string | null => {
    const perToken = Number(raw)
    if (!Number.isFinite(perToken) || perToken <= 0) return null
    const value = perToken * 1_000_000
    return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 100) / 100)
  }
  const input = perMillion(pricing.input)
  const output = perMillion(pricing.output)
  if (!input || !output) return null
  return `$${input}/M in · $${output}/M out`
}

// Map the gateway's /models metadata to renderer ModelOptions. Only language
// models are chat-selectable; embedding/image/etc. entries are dropped.
export function mapGatewayModels(entries: GatewayModelEntry[]): GatewayModelOption[] {
  const options: GatewayModelOption[] = []
  for (const entry of entries) {
    if (typeof entry?.id !== 'string' || !entry.id.trim()) continue
    if (entry.modelType != null && entry.modelType !== 'language') continue
    const label = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : entry.id
    const pricing = formatPricing(entry.pricing)
    const description = [entry.description?.trim(), pricing].filter(Boolean).join(' — ') || undefined
    options.push({ id: entry.id, label, ...(description ? { description } : {}) })
  }
  return options
}

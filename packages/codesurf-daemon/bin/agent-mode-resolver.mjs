import {
  AGENT_MODE_RESOLUTION_DENIED_ERROR,
  DEFAULT_PERSONAS,
  listAuthoritativePersonas,
  overlayAuthoritativePersonas,
  resolveAuthoritativePersona,
} from '../dist/chat-policy.js'

export {
  AGENT_MODE_RESOLUTION_DENIED_ERROR,
  DEFAULT_PERSONAS,
}

/** @deprecated Retained for the existing agent-mode wire terminology. */
export const DEFAULT_AGENT_MODES = DEFAULT_PERSONAS

// Compatibility display helper. Authoritative execution never uses this
// lenient path; it uses resolveAuthoritativePersona's strict bounded parser.
function resolvePersonaExtends(persona, byId) {
  const chain = []
  const seen = new Set()
  let current = persona
  let broken = false
  for (;;) {
    chain.push(current)
    seen.add(current.id)
    const baseId = typeof current.extends === 'string' ? current.extends.trim() : ''
    if (!baseId) break
    const base = byId.get(baseId)
    if (!base || base.id === current.id || seen.has(base.id)) {
      broken = true
      break
    }
    current = base
  }
  let merged = {}
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const node = chain[index]
    merged = { ...merged, ...node }
    if (Object.hasOwn(node, 'tools')) merged.tools = node.tools
  }
  merged.id = persona.id
  if (broken && !Object.hasOwn(persona, 'tools')) merged.tools = []
  return merged
}

export function overlayPersonas(loaded) {
  const merged = DEFAULT_PERSONAS.map(persona => ({ ...persona }))
  if (!Array.isArray(loaded)) return merged
  for (const item of loaded) {
    if (!item || typeof item.id !== 'string' || item.id.startsWith('discovered-')) continue
    const index = merged.findIndex(persona => persona.id === item.id)
    if (index >= 0) merged[index] = { ...merged[index], ...item }
    else merged.push(item)
  }
  const byId = new Map(merged.map(persona => [persona.id, persona]))
  return merged.map(persona => resolvePersonaExtends(persona, byId))
}

/** @deprecated Retained for existing callers. */
export const overlayAgentModes = overlayPersonas

export function findPersonaById(personas, personaId) {
  return personas.find(persona => persona.id === personaId) ?? null
}

/** @deprecated Retained for existing callers. */
export const findAgentModeById = findPersonaById

export async function resolveAuthoritativeAgentMode(options) {
  let workspaceRoot = null
  try {
    workspaceRoot = await options.resolveWorkspaceRoot()
  } catch {
    workspaceRoot = null
  }
  return await resolveAuthoritativePersona({
    agentId: options?.agentId,
    workspaceRoot,
  })
}

export async function listPersonas(options) {
  let workspaceRoot = null
  try {
    workspaceRoot = await options.resolveWorkspaceRoot()
  } catch {
    workspaceRoot = null
  }
  return await listAuthoritativePersonas(workspaceRoot)
}

// Exported for policy/conformance tests. Production resolution above is the
// only execution authority.
export const strictOverlayPersonas = overlayAuthoritativePersonas

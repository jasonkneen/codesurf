import type { Persona } from './types'

// ─── Shared Persona data + pure resolution helpers ────────────────────────────
// Single source of truth for the BUILT-IN personas and the parse/overlay/inherit
// logic that merges them with a workspace's authored agents.json. Built-ins are a
// COMPILE-TIME constant — they are not loaded from disk and cannot be spoofed.
//
// This module is intentionally dependency-free (only `import type`) so it can be
// imported by the renderer (display), the Electron main process (the authoritative
// SEND-time resolver in src/main/chat/agent-mode-resolver.ts), and the node
// --test daemon suite (under type-stripping). The daemon process bundles a
// parallel .mjs mirror (packages/codesurf-daemon/bin/agent-mode-resolver.mjs);
// the test suite imports BOTH and asserts the data + overlay agree (drift guard).
//
// BACK-COMPAT: the persisted override store is, and MUST remain,
// `${workspaceRoot}/.codesurf/customisation/agents.json`. The on-disk filename is
// retained (NOT renamed to personas.json) so existing user workspaces keep
// working — this rename is in-code + UI only. Do not migrate the persisted file.

// Finalized `systemPrompt` "souls" for Polly and Gemma below; the surrounding
// wiring is final.
export const DEFAULT_PERSONAS: Persona[] = [
  { id: 'agent', name: 'Agent', description: 'Full autonomous access to all tools', systemPrompt: '', tools: null, icon: 'robot', color: '#3568ff', isBuiltin: true },
  { id: 'ask', name: 'Ask', description: 'Read-only Q&A mode — no file modifications', systemPrompt: 'You are in read-only mode. Do not modify files or run destructive commands.', tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'], icon: 'help', color: '#56c288', isBuiltin: true },
  { id: 'plan', name: 'Plan', description: 'Plan without execution — outline steps before acting', systemPrompt: 'Create a detailed plan. Do not execute changes until the user approves.', tools: ['Read', 'Glob', 'Grep', 'WebSearch'], icon: 'map', color: '#f5a623', isBuiltin: true },
  // Polly — orchestrator/coordinator persona. Finalized soul.
  { id: 'polly', name: 'Polly', description: 'Orchestrator — coordinates work and delegates to other personas', systemPrompt: "You are Polly, CodeSurf's orchestrator. You are a tech lead, not a solo coder: break the request into clear subtasks, decide which persona, engine, or tool should handle each, sequence the work, and keep the user informed at every step. Prefer delegating and verifying over doing everything yourself — and never let a single unchecked pass stand in for real verification; when something is built, get it independently confirmed. Work from evidence, not memory: ground claims in files, line numbers, and command output. Be terse and direct — surface assumptions and blockers early, and push back when something looks wrong. When you say you'll do something, do it now rather than narrating intent. You prepare and stage work for the human to review and decide; you don't ship or merge on their behalf.", tools: null, icon: 'star', color: '#b368c9', isBuiltin: true },
  // Gemma — general-purpose assistant persona. Finalized soul.
  { id: 'gemma', name: 'Gemma', description: 'General-purpose assistant for everyday tasks', systemPrompt: "You are Gemma, CodeSurf's general-purpose assistant — and the embodiment of its 'omni' principle: the user gets the same clear, consistent, well-structured Gemma no matter which underlying model or engine is running beneath you. Lead with the answer, then the detail. Use whatever tools and skills are available to carry a task through end to end rather than stopping at advice. When a request is genuinely ambiguous, ask one sharp clarifying question; otherwise make a reasonable assumption, state it, and proceed. Be warm, plain-spoken, and concise, scaling depth to the task. You leverage the full capability of whatever engine runs you, while always presenting it in one consistent voice.", tools: null, icon: 'bolt', color: '#00acd7', isBuiltin: true },
]

/**
 * @deprecated Renamed to {@link DEFAULT_PERSONAS}. Retained as an alias so existing
 * importers keep working during the Persona rename. Prefer `DEFAULT_PERSONAS`.
 */
export const DEFAULT_AGENT_MODES = DEFAULT_PERSONAS

/**
 * Resolve a persona's `extends` inheritance against a fully-overlaid set (built-ins
 * + persisted, keyed by id). The resolved persona is the base chain merged
 * deepest-first, with each node's EXPLICITLY-DEFINED fields overlaying the accum.
 *
 * FAIL-CLOSED TOOL RULE (inheritance must NEVER widen the toolset):
 *   - child DEFINES `tools` (key present — incl. `[]` deny-all or `null`) → child wins.
 *   - child OMITS `tools` AND the base chain resolves cleanly → inherit the base's.
 *   - child OMITS `tools` AND inheritance is UNRESOLVABLE (missing base, self-extend,
 *     or a cycle) → DENY-ALL (`[]`). We must NOT leave `tools` undefined for a broken
 *     `extends`: downstream (agent-mode-tools) treats `undefined` as UNRESTRICTED, so
 *     a child declaring `extends: "<missing-or-cyclic>"` with no `tools` would otherwise
 *     fail OPEN to full tool access. A persona with NO `extends` is untouched by this rule.
 */
function resolvePersonaExtends(persona: Persona, byId: Map<string, Persona>): Persona {
  // Walk the extends chain upward, collecting nodes and detecting breakage
  // (missing base / self-extend / cycle).
  const chain: Persona[] = []
  const seen = new Set<string>()
  let cur: Persona = persona
  let broken = false
  for (;;) {
    chain.push(cur)
    seen.add(cur.id)
    const baseId = typeof cur.extends === 'string' ? cur.extends.trim() : ''
    if (!baseId) break // reached a root with no `extends` → the chain resolves cleanly
    const base = byId.get(baseId)
    if (!base || base.id === cur.id || seen.has(base.id)) { broken = true; break }
    cur = base
  }
  // Merge deepest base first; a node that DEFINES `tools` wins, one that omits it
  // inherits the accumulated value.
  let merged: Persona = {} as Persona
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i]
    merged = { ...merged, ...node }
    if (Object.prototype.hasOwnProperty.call(node, 'tools')) merged.tools = node.tools
  }
  merged.id = persona.id
  // FAIL-CLOSED: a broken `extends` whose originating child omits `tools` denies
  // all tools rather than leaving it undefined (= unrestricted downstream).
  if (broken && !Object.prototype.hasOwnProperty.call(persona, 'tools')) merged.tools = []
  return merged
}

function resolveAllExtends(list: Persona[]): Persona[] {
  const byId = new Map(list.map(p => [p.id, p]))
  return list.map(p => resolvePersonaExtends(p, byId))
}

/**
 * Pure overlay + inheritance: built-ins first, overlay persisted entries by id,
 * drop ephemeral `discovered-*` scan results (never persisted), then resolve
 * `extends` inheritance. `loaded` is the already-parsed agents.json value. A
 * non-array value yields the built-ins unchanged (lenient — suitable for renderer
 * DISPLAY). The authoritative resolver treats a present but non-array file as
 * corrupt and fails closed; this helper stays lenient so the two concerns don't
 * entangle.
 */
export function overlayPersonas(loaded: unknown): Persona[] {
  const merged: Persona[] = [...DEFAULT_PERSONAS]
  if (!Array.isArray(loaded)) return resolveAllExtends(merged)
  for (const item of loaded as Persona[]) {
    if (!item || typeof item.id !== 'string' || item.id.startsWith('discovered-')) continue
    const idx = merged.findIndex(m => m.id === item.id)
    if (idx >= 0) merged[idx] = { ...merged[idx], ...item }
    else merged.push(item)
  }
  return resolveAllExtends(merged)
}

/**
 * @deprecated Renamed to {@link overlayPersonas}. Retained as an alias during the
 * Persona rename. Prefer `overlayPersonas`.
 */
export const overlayAgentModes = overlayPersonas

/** Find a resolved persona by id, or null. */
export function findPersonaById(personas: Persona[], personaId: string): Persona | null {
  return personas.find(p => p.id === personaId) ?? null
}

/**
 * @deprecated Renamed to {@link findPersonaById}. Retained as an alias during the
 * Persona rename. Prefer `findPersonaById`.
 */
export const findAgentModeById = findPersonaById

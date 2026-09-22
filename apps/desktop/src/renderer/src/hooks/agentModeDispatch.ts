import type { AgentMode } from '../../../shared/types'

// ─── Authoritative AgentMode resolution for a SEND ────────────────────────────
// Pure + dependency-injected so the load-race contract is testable without a
// React/DOM runner (the repo has none — see chatModeResolution.ts). The composer
// seeds the built-in modes (agent/ask/plan) synchronously for snappy UX, then
// overlays agents.json asynchronously. That seam is the bug: if a workspace
// OVERRIDES a built-in id to be STRICTER in agents.json, there is a sub-second
// window after a tile (re)load where the seeded, LOOSER default built-in is what
// a send would carry. The default is non-null and valid-looking, so the IPC /
// daemon / builder fail-closed guards — which only trip on a null/unresolved
// agentMode — do NOT fire, and the turn runs with the default's tools (for the
// overridden `agent`, that is tools:null = UNRESTRICTED) for one turn. This is
// the only place that window can be closed; the lower layers cannot tell a looser
// default apart from a legitimate resolution.

export type DispatchAgentResolution =
  | { ok: true; agentMode: AgentMode | null }
  | { ok: false }

/**
 * Resolve the AgentMode a send must dispatch with.
 *
 *  - No agent selected → dispatch with `agentMode: null` (unrestricted by design;
 *    matches the builders' "no agentId launches" path). Never fail-closed here.
 *  - Agent selected, definitions already loaded → use the resolved mode (the
 *    loaded list already reflects any agents.json override). Null → fail closed.
 *  - Agent selected, definitions NOT yet loaded → IGNORE the seeded built-in and
 *    AWAIT the authoritative load, resolving the override. If the load fails or the
 *    id resolves to nothing → fail closed. The pre-load default is NEVER used for
 *    a send, so a stricter override can never be bypassed by the load race.
 */
export async function resolveDispatchAgentMode(opts: {
  agentId: string | null
  resolvedAgentMode: AgentMode | null
  agentModesLoaded: boolean
  loadFinalModes: () => Promise<AgentMode[]>
}): Promise<DispatchAgentResolution> {
  const { agentId, resolvedAgentMode, agentModesLoaded, loadFinalModes } = opts

  // No agent selected: dispatch unrestricted-by-design (provider default tools).
  if (!agentId) return { ok: true, agentMode: null }

  // Agent selected but definitions still loading: the seeded value may be a
  // LOOSER default built-in. Re-resolve authoritatively from agents.json before
  // dispatch; never trust the pre-load seed for a send.
  if (!agentModesLoaded) {
    let authoritative: AgentMode[]
    try {
      authoritative = await loadFinalModes()
    } catch {
      return { ok: false } // load failed → fail closed, do not launch
    }
    const finalMode = authoritative.find(a => a.id === agentId) ?? null
    if (!finalMode) return { ok: false }
    return { ok: true, agentMode: finalMode }
  }

  // Definitions loaded: the resolved mode already reflects any override.
  if (!resolvedAgentMode) return { ok: false }
  return { ok: true, agentMode: resolvedAgentMode }
}

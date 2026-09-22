import type { Persona, PersonaBinding, SkillDefinition } from '../../../shared/types'

// ─── Persona soft model/provider seeding (P1b-1) ──────────────────────────────
// Dissociates model from persona IDENTITY: a Persona carries at most an OPTIONAL
// soft `defaultBinding` (provider/model). Selecting that persona SEEDS the
// composer's provider/model control; the user remains free to change it.
//
// PRECEDENCE LADDER (model selection):
//   1) [P1b-2, NOT IMPLEMENTED] skill-required model = HARD lock. SEAM: a future
//      resolver runs ABOVE this, short-circuits, and returns a locked result the
//      composer disables. `locked` is reserved on PersonaModelSeed for that.
//   2) Persona soft default = seeds the composer when the persona is selected
//      (this module).
//   3) Composer/user pick = free override; wins over the soft default.
//
// Layer 3 needs NO code here: seeding happens once, at selection time, in the
// onSelectAgent click handler. After that the LIVE composer state is the single
// source of truth — the dispatch path (useChatTileMessaging) builds req.model /
// req.provider from the live `model`/`provider` state and NEVER reads
// `defaultBinding`. That decoupling is what makes the user's pick win. Do NOT add
// a binding fallback at dispatch (it would re-couple model to identity).
//
// model is NOT a security boundary: this never touches resolveAuthoritativeAgentMode
// (the trusted-disk tools/permission path), which stays fail-closed and model-free.

export interface PersonaModelSeed {
  /** Provider id to seed into the composer, if the binding specifies one. */
  provider?: string
  /** Model id to seed into the composer, if the binding specifies one. */
  model?: string
  /**
   * P1b-2 (layer 1): true when this is a HARD skill-lock (from resolveSkillModelLock)
   * rather than a soft seed. Callers disable the composer's model/provider picker and
   * force the live state to provider/model. Unset/false for soft seeds (layer 2).
   */
  locked?: boolean
  /** Human-readable explanation of the lock, surfaced as the disabled pill's tooltip. */
  reason?: string
}

function cleanField(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Resolve the HARD skill-defined model lock for a persona (precedence LAYER 1 —
 * runs ABOVE resolvePersonaModelSeed). A persona may LINK skills via `persona.skills`
 * (matched against `workspaceSkills` by `id` OR `name`). The FIRST linked skill that
 * declares a `requiredModel` wins: its model (and `requiredProvider`, if set) PIN the
 * composer and the picker is disabled. Returns null when no linked skill imposes a
 * lock, so the caller falls through to the soft default (layer 2) / user pick (layer 3).
 *
 * model is NOT a security boundary: this drives composer disablement only and never
 * touches resolveAuthoritativeAgentMode (the trusted-disk tools/permission path).
 */
export function resolveSkillModelLock(
  persona: Persona | null | undefined,
  workspaceSkills: SkillDefinition[] | null | undefined,
): PersonaModelSeed | null {
  const linked = persona?.skills
  if (!Array.isArray(linked) || linked.length === 0) return null
  if (!Array.isArray(workspaceSkills) || workspaceSkills.length === 0) return null
  for (const ref of linked) {
    const key = cleanField(typeof ref === 'string' ? ref : undefined)
    if (!key) continue
    const skill = workspaceSkills.find(s => s?.id === key || s?.name === key)
    if (!skill) continue
    // requiredModel is the lock TRIGGER ("first linked skill with requiredModel wins").
    const model = cleanField(skill.requiredModel)
    if (!model) continue
    const provider = cleanField(skill.requiredProvider)
    const lock: PersonaModelSeed = {
      model,
      locked: true,
      reason: `Model locked by skill "${skill.name}"`,
    }
    if (provider) lock.provider = provider
    return lock
  }
  return null
}

/**
 * Resolve the SOFT model seed for a persona (precedence layer 2). Returns null
 * when the persona carries no usable soft default, so the caller leaves the
 * composer untouched (preserving the user's current/saved selection).
 */
export function resolvePersonaModelSeed(persona: Persona | null | undefined): PersonaModelSeed | null {
  const binding: PersonaBinding | undefined = persona?.defaultBinding
  if (!binding) return null
  const provider = cleanField(binding.provider)
  const model = cleanField(binding.model)
  if (!provider && !model) return null
  const seed: PersonaModelSeed = {}
  if (provider) seed.provider = provider
  if (model) seed.model = model
  return seed
}

// Daemon-side mirror of src/renderer/src/hooks/personaModelBinding.ts.
//
// Kept separate (not imported from the renderer) because the daemon package is
// self-contained: its published `files` manifest ships only bin/ dist/ vendor/,
// while its compiled CLI cannot import the excluded desktop renderer/shared
// tree. This is the same shared↔daemon mirror
// discipline used by agent-mode-resolver.mjs / agent-mode-tools.mjs. The
// test/daemon suite drift-guards this copy against the renderer original.
//
// resolvePersonaModelSeed is the SOFT model/provider seed (precedence layer 2):
// selecting a persona seeds the composer's provider/model from its optional
// `defaultBinding`; the user's explicit pick always overrides it. model is NOT a
// security boundary — this never touches the authoritative tools/permission
// resolver, which stays fail-closed and model-free.

export interface PersonaModelSeed {
  /** Provider id to seed, if the binding specifies one. */
  provider?: string
  /** Model id to seed, if the binding specifies one. */
  model?: string
}

/** Minimal persona shape this resolver needs (a soft, optional binding). */
export interface PersonaBindingLike {
  provider?: string
  model?: string
}
export interface PersonaLike {
  defaultBinding?: PersonaBindingLike
}

function cleanField(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Resolve the SOFT model seed for a persona (precedence layer 2). Returns null
 * when the persona carries no usable soft default, so the caller leaves the
 * composer/provider untouched (preserving the user's current/saved selection).
 */
export function resolvePersonaModelSeed(persona: PersonaLike | null | undefined): PersonaModelSeed | null {
  const binding = persona?.defaultBinding
  if (!binding) return null
  const provider = cleanField(binding.provider)
  const model = cleanField(binding.model)
  if (!provider && !model) return null
  const seed: PersonaModelSeed = {}
  if (provider) seed.provider = provider
  if (model) seed.model = model
  return seed
}

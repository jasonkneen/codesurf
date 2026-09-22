/**
 * Pi model availability — catalog usable models and fail launches that would
 * otherwise complete as empty assistant turns (expired OAuth / missing keys).
 */

export interface PiModelCandidate {
  provider: string
  id: string
  name?: string
}

export interface PiModelOption {
  id: string
  label: string
  description?: string
}

export type PiLaunchModelPlan =
  | { ok: true; ref: { provider: string; id: string } }
  | { ok: false; error: string }

export interface PiProviderProbeSample {
  provider: string
  apiKey?: string | null
  error?: string
}

export interface PiProviderProbeResult {
  usable: Set<string>
  errors: string[]
  errorByProvider: Map<string, string>
}

export function collectPiProviderProbe(
  results: readonly PiProviderProbeSample[],
): PiProviderProbeResult {
  const usable = new Set<string>()
  const errors: string[] = []
  const errorByProvider = new Map<string, string>()
  for (const result of results) {
    if (result.apiKey) {
      usable.add(result.provider)
      continue
    }
    const error = result.error?.trim() || `No API key for provider: ${result.provider}`
    errors.push(error)
    errorByProvider.set(result.provider, error)
  }
  return { usable, errors, errorByProvider }
}

export function parsePiModelRef(model: string | null | undefined): { provider: string; id: string } | null {
  const raw = String(model ?? '').trim()
  if (!raw) return null
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1) return null
  return { provider: raw.slice(0, slash), id: raw.slice(slash + 1) }
}

export function piModelOptionId(provider: string, id: string): string {
  return `${provider}/${id}`
}

export function toPiModelOption(candidate: PiModelCandidate): PiModelOption {
  return {
    id: piModelOptionId(candidate.provider, candidate.id),
    label: candidate.name || candidate.id,
    description: candidate.provider,
  }
}

export function catalogUsablePiModels(
  candidates: readonly PiModelCandidate[],
  usableProviders: Iterable<string>,
): PiModelOption[] {
  const usable = usableProviders instanceof Set ? usableProviders : new Set(usableProviders)
  const seen = new Set<string>()
  const models: PiModelOption[] = []
  for (const candidate of candidates) {
    if (!usable.has(candidate.provider)) continue
    const option = toPiModelOption(candidate)
    if (seen.has(option.id)) continue
    seen.add(option.id)
    models.push(option)
  }
  return models
}

export function formatPiCatalogError(input: {
  models: readonly PiModelOption[]
  probeErrors?: readonly string[]
  runtimeError?: string
}): string | undefined {
  const runtimeError = input.runtimeError?.trim()
  if (runtimeError) return runtimeError
  if (input.models.length > 0) return undefined
  const detail = (input.probeErrors ?? []).map(error => error.trim()).filter(Boolean).join('; ')
  if (detail) {
    return `Pi has no usable models. ${detail} Run \`pi login\` or add credentials in ~/.pi/agent/auth.json.`
  }
  return 'Pi has no usable models. Run `pi login` to add credentials, then pick that provider.'
}

export function summarizePiModelIds(models: readonly PiModelOption[], limit = 8): string {
  const ids = models.map(model => model.id)
  const shown = ids.slice(0, limit)
  const extra = ids.length - shown.length
  return extra > 0 ? `${shown.join(', ')} (+${extra} more)` : shown.join(', ')
}

export function planPiLaunchModel(input: {
  requested: string
  usableModels: readonly PiModelOption[]
  requestedProviderError?: string
}): PiLaunchModelPlan {
  const ref = parsePiModelRef(input.requested)
  if (!ref) {
    if (input.usableModels.length === 0) {
      return { ok: false, error: formatPiCatalogError({ models: [] }) ?? 'Pi has no usable models.' }
    }
    return {
      ok: false,
      error: `No Pi model selected. Available: ${summarizePiModelIds(input.usableModels)}.`,
    }
  }

  const requestedId = piModelOptionId(ref.provider, ref.id)
  if (input.usableModels.some(model => model.id === requestedId)) {
    return { ok: true, ref }
  }

  const why = input.requestedProviderError?.trim() || 'no usable credentials'
  if (input.usableModels.length === 0) {
    return {
      ok: false,
      error: `Pi cannot use ${requestedId}: ${why}. Run \`pi login ${ref.provider}\` or \`pi login\`.`,
    }
  }
  return {
    ok: false,
    error: `Pi cannot use ${requestedId}: ${why}. Available: ${summarizePiModelIds(input.usableModels)}. Or run \`pi login ${ref.provider}\`.`,
  }
}

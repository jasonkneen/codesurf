import type { GenerationProviderSettings } from '../shared/types'

export interface GenerationProviderModel {
  id: string
  name: string
  label: string
  methods: string[]
  capabilities: Array<'image' | 'video' | 'text'>
}

export interface GenerationProviderValidationResult {
  ok: boolean
  providerId: string
  message: string
  models: GenerationProviderModel[]
  textModels: GenerationProviderModel[]
  imageModels: GenerationProviderModel[]
  videoModels: GenerationProviderModel[]
}

interface GeminiModelResponse {
  models?: Array<Record<string, unknown>>
  nextPageToken?: string
  error?: { message?: string }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function stripModelPrefix(name: string): string {
  return name.replace(/^models\//, '')
}

export function normalizeGeminiModel(raw: Record<string, unknown>): GenerationProviderModel {
  const name = asString(raw.name)
  const id = stripModelPrefix(asString(raw.baseModelId) || name)
  const label = asString(raw.displayName) || id
  const methods = asStringArray(raw.supportedGenerationMethods)
  const searchable = `${id} ${name} ${label} ${asString(raw.description)}`.toLowerCase()
  const capabilities = new Set<'image' | 'video' | 'text'>()

  if (methods.includes('generateContent')) capabilities.add('text')
  if (
    searchable.includes('image')
    || searchable.includes('imagen')
    || searchable.includes('nano banana')
    || /gemini-[\w.-]+-flash-image/.test(searchable)
  ) {
    capabilities.add('image')
  }
  if (searchable.includes('veo') || methods.includes('predictLongRunning')) {
    capabilities.add('video')
  }

  return { id, name, label, methods, capabilities: Array.from(capabilities) }
}

export function splitProviderModels(models: GenerationProviderModel[]): Pick<GenerationProviderValidationResult, 'models' | 'textModels' | 'imageModels' | 'videoModels'> {
  return {
    models,
    textModels: models.filter(model => model.capabilities.includes('text')),
    imageModels: models.filter(model => model.capabilities.includes('image')),
    videoModels: models.filter(model => model.capabilities.includes('video')),
  }
}

export function normalizeAnthropicModel(raw: Record<string, unknown>): GenerationProviderModel {
  const id = asString(raw.id)
  return {
    id,
    name: id,
    label: asString(raw.display_name) || id,
    methods: ['messages'],
    capabilities: ['text'],
  }
}

export function normalizeOpenRouterModel(raw: Record<string, unknown>): GenerationProviderModel {
  const id = asString(raw.id)
  const architecture = raw.architecture && typeof raw.architecture === 'object'
    ? raw.architecture as Record<string, unknown>
    : {}
  const outputModalities = asStringArray(architecture.output_modalities)
  const capabilities = new Set<'image' | 'video' | 'text'>()
  if (outputModalities.includes('text')) capabilities.add('text')
  if (outputModalities.includes('image')) capabilities.add('image')
  if (outputModalities.includes('video')) capabilities.add('video')
  if (capabilities.size === 0) capabilities.add('text')

  return {
    id,
    name: id,
    label: asString(raw.name) || id,
    methods: ['chat.completions'],
    capabilities: Array.from(capabilities),
  }
}

async function parseResponse(response: Response): Promise<GeminiModelResponse> {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text) as GeminiModelResponse
  } catch {
    return { error: { message: text } }
  }
}

export async function validateGenerationProvider(provider: GenerationProviderSettings): Promise<GenerationProviderValidationResult> {
  if (provider.id === 'gemini') {
    const apiKey = provider.apiKey?.trim()
    if (!apiKey) {
      return {
        ok: false,
        providerId: provider.id,
        message: 'Missing Gemini API key.',
        models: [],
        textModels: [],
        imageModels: [],
        videoModels: [],
      }
    }

    const allModels: GenerationProviderModel[] = []
    let pageToken = ''
    do {
      const url = new URL('https://generativelanguage.googleapis.com/v1beta/models')
      url.searchParams.set('pageSize', '1000')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const response = await fetch(url, { headers: { 'x-goog-api-key': apiKey } })
      const payload = await parseResponse(response)
      if (!response.ok) {
        return {
          ok: false,
          providerId: provider.id,
          message: payload.error?.message || `Gemini key validation failed (${response.status}).`,
          models: [],
          textModels: [],
          imageModels: [],
          videoModels: [],
        }
      }
      allModels.push(...(payload.models ?? []).map(normalizeGeminiModel))
      pageToken = payload.nextPageToken ?? ''
    } while (pageToken)

    const split = splitProviderModels(allModels)
    return {
      ok: true,
      providerId: provider.id,
      message: `Gemini key valid. Found ${allModels.length} models, ${split.imageModels.length} image models, ${split.videoModels.length} video models.`,
      ...split,
    }
  }

  if (provider.id === 'anthropic') {
    const apiKey = provider.apiKey?.trim()
    if (!apiKey) {
      return { ok: false, providerId: provider.id, message: 'Missing Anthropic API key.', models: [], textModels: [], imageModels: [], videoModels: [] }
    }
    const response = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    })
    const payload = await response.json().catch(() => ({})) as { data?: Array<Record<string, unknown>>; error?: { message?: string } }
    if (!response.ok) {
      return { ok: false, providerId: provider.id, message: payload.error?.message || `Anthropic key validation failed (${response.status}).`, models: [], textModels: [], imageModels: [], videoModels: [] }
    }
    const models = (payload.data ?? []).map(normalizeAnthropicModel)
    return { ok: true, providerId: provider.id, message: `Anthropic key valid. Found ${models.length} models.`, ...splitProviderModels(models) }
  }

  if (provider.id === 'openrouter') {
    const apiKey = provider.apiKey?.trim()
    if (!apiKey) {
      return { ok: false, providerId: provider.id, message: 'Missing OpenRouter API key.', models: [], textModels: [], imageModels: [], videoModels: [] }
    }
    const baseUrl = (provider.baseUrl?.trim() || 'https://openrouter.ai/api/v1').replace(/\/$/, '')
    const response = await fetch(`${baseUrl}/models/user`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })
    const payload = await response.json().catch(() => ({})) as { data?: Array<Record<string, unknown>>; error?: { message?: string } }
    if (!response.ok) {
      return { ok: false, providerId: provider.id, message: payload.error?.message || `OpenRouter key validation failed (${response.status}).`, models: [], textModels: [], imageModels: [], videoModels: [] }
    }
    const models = (payload.data ?? []).map(normalizeOpenRouterModel)
    const split = splitProviderModels(models)
    return {
      ok: true,
      providerId: provider.id,
      message: `OpenRouter key valid. Found ${models.length} models, ${split.imageModels.length} image-capable models.`,
      ...split,
    }
  }

  if (provider.id === 'local') {
    const baseUrl = provider.baseUrl?.trim()
    if (!baseUrl) {
      return { ok: false, providerId: provider.id, message: 'Missing local provider base URL.', models: [], textModels: [], imageModels: [], videoModels: [] }
    }
    const response = await fetch(new URL('/v1/models', baseUrl))
    if (!response.ok) {
      return { ok: false, providerId: provider.id, message: `Local provider model listing failed (${response.status}).`, models: [], textModels: [], imageModels: [], videoModels: [] }
    }
    const payload = await response.json().catch(() => ({})) as { data?: Array<{ id?: string; name?: string }> }
    const models = (payload.data ?? []).flatMap(model => {
      const id = model.id || model.name || ''
      return id ? [{ id, name: id, label: id, methods: [], capabilities: ['text' as const] }] : []
    })
    return { ok: true, providerId: provider.id, message: `Local provider reachable. Found ${models.length} models.`, ...splitProviderModels(models) }
  }

  return {
    ok: false,
    providerId: provider.id,
    message: `${provider.label} validation is not implemented yet.`,
    models: [],
    textModels: [],
    imageModels: [],
    videoModels: [],
  }
}

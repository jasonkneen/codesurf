import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'path'
import type { AppSettings, GenerationProviderSettings } from '../shared/types'

export interface SelectedImageProvider {
  provider: GenerationProviderSettings
  model: string
}

export interface GeminiInlineImage {
  data: string
  mimeType: string
}

export function selectImageProvider(settings: AppSettings, requestedProvider?: string): SelectedImageProvider | string {
  const providers = Object.values(settings.generationProviders ?? {})
  const normalize = (value: string): string => value.trim().toLowerCase()

  if (requestedProvider?.trim()) {
    const requested = normalize(requestedProvider)
    const provider = providers.find(entry => normalize(entry.id) === requested || normalize(entry.label) === requested)
    if (!provider) return `Image generation provider "${requestedProvider}" is not configured`
    if (!provider.enabled) return `Image generation provider "${provider.label}" is disabled in Settings > Providers`
    if (!provider.capabilities.includes('image')) return `Image generation provider "${provider.label}" does not support images`
    if (!provider.apiKey?.trim() && provider.id !== 'local') return `Image generation provider "${provider.label}" needs an API key in Settings > Providers`
    return { provider, model: provider.imageModel?.trim() || defaultImageModelForProvider(provider.id) }
  }

  const candidates = providers.filter(provider =>
    provider.enabled
    && provider.capabilities.includes('image')
    && (provider.apiKey?.trim() || provider.id === 'local'),
  )
  const provider = candidates.find(entry => entry.id === 'gemini') ?? candidates[0]
  if (!provider) return 'No enabled image provider with an API key. Open Settings > Providers, enable Gemini / Nano Banana, and add an API key.'
  return { provider, model: provider.imageModel?.trim() || defaultImageModelForProvider(provider.id) }
}

export function defaultImageModelForProvider(providerId: string): string {
  if (providerId === 'gemini') return 'gemini-2.5-flash-image'
  return ''
}

export function mimeTypeForImagePath(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'image/png'
}

export function extensionForMimeType(mimeType: string, fallbackPath?: string): string {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return '.jpg'
  if (normalized.includes('png')) return '.png'
  if (normalized.includes('webp')) return '.webp'
  if (normalized.includes('gif')) return '.gif'
  const fallback = fallbackPath ? extname(fallbackPath) : ''
  return fallback || '.png'
}

export function makeImageOutputPath(sourcePath: string, explicitOutputPath: string | undefined, mimeType = 'image/png'): string {
  const sourceDir = dirname(sourcePath)
  if (explicitOutputPath?.trim()) {
    const requested = explicitOutputPath.trim()
    const resolved = isAbsolute(requested) ? resolve(requested) : resolve(sourceDir, requested)
    // The output path is renderer/MCP-supplied: keep it inside the source
    // image's directory tree so a prompt-injected agent can't clobber
    // arbitrary files (~/.zshrc, ~/.codesurf/secrets.json) with image bytes.
    const rel = relative(sourceDir, resolved)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Output path must stay inside the source image directory: ${requested}`)
    }
    return resolved
  }

  const ext = extensionForMimeType(mimeType, sourcePath)
  const base = basename(sourcePath, extname(sourcePath) || ext).replace(/[^\w.-]+/g, '-')
  return join(sourceDir, `${base}-edited-${Date.now()}${ext}`)
}

export function extractGeminiInlineImage(payload: unknown): GeminiInlineImage | null {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const candidates = Array.isArray(root.candidates) ? root.candidates : []

  for (const candidate of candidates) {
    const candidateObj = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {}
    const content = candidateObj.content && typeof candidateObj.content === 'object'
      ? candidateObj.content as Record<string, unknown>
      : {}
    const parts = Array.isArray(content.parts) ? content.parts : []

    for (const part of parts) {
      const partObj = part && typeof part === 'object' ? part as Record<string, unknown> : {}
      const inlineData = (partObj.inlineData ?? partObj.inline_data)
      const inlineObj = inlineData && typeof inlineData === 'object' ? inlineData as Record<string, unknown> : null
      const data = typeof inlineObj?.data === 'string' ? inlineObj.data : ''
      if (!data) continue
      const mimeType = typeof inlineObj?.mimeType === 'string'
        ? inlineObj.mimeType
        : typeof inlineObj?.mime_type === 'string'
          ? inlineObj.mime_type
          : 'image/png'
      return { data, mimeType }
    }
  }

  return null
}

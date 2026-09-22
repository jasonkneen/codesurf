import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  normalizeAnthropicModel,
  normalizeGeminiModel,
  normalizeOpenRouterModel,
  splitProviderModels,
} from '../src/main/generation-provider-validation.ts'
import { withDefaultSettings } from '../src/shared/types.ts'

describe('generation provider validation helpers', () => {
  test('merges new built-in provider capabilities into older saved settings', () => {
    const settings = withDefaultSettings({
      generationProviders: {
        gemini: {
          id: 'gemini',
          label: 'Gemini / Nano Banana',
          enabled: false,
          capabilities: ['image'],
        },
      },
    })

    expect(settings.generationProviders.gemini.capabilities).toContain('image')
    expect(settings.generationProviders.gemini.capabilities).toContain('video')
    expect(settings.generationProviders.anthropic.capabilities).toContain('text')
    expect(settings.generationProviders.openrouter.capabilities).toContain('text')
  })

  test('classifies Gemini image and Veo video models from list response metadata', () => {
    const image = normalizeGeminiModel({
      name: 'models/gemini-2.5-flash-image',
      baseModelId: 'gemini-2.5-flash-image',
      displayName: 'Gemini 2.5 Flash Image',
      supportedGenerationMethods: ['generateContent'],
    })
    const video = normalizeGeminiModel({
      name: 'models/veo-3.1-generate-preview',
      baseModelId: 'veo-3.1-generate-preview',
      displayName: 'Veo 3.1 Generate Preview',
      supportedGenerationMethods: ['predictLongRunning'],
    })

    expect(image.capabilities).toContain('image')
    expect(video.capabilities).toContain('video')

    const split = splitProviderModels([image, video])
    expect(split.imageModels.map(model => model.id)).toContain('gemini-2.5-flash-image')
    expect(split.videoModels.map(model => model.id)).toContain('veo-3.1-generate-preview')
  })

  test('normalizes Anthropic and OpenRouter text model listings', () => {
    const anthropic = normalizeAnthropicModel({
      id: 'claude-sonnet-4-20250514',
      display_name: 'Claude Sonnet 4',
    })
    const openrouter = normalizeOpenRouterModel({
      id: 'anthropic/claude-sonnet-4',
      name: 'Anthropic: Claude Sonnet 4',
      architecture: { output_modalities: ['text'] },
    })

    expect(anthropic.capabilities).toContain('text')
    expect(openrouter.capabilities).toContain('text')

    const split = splitProviderModels([anthropic, openrouter])
    expect(split.textModels.map(model => model.id)).toContain('claude-sonnet-4-20250514')
    expect(split.textModels.map(model => model.id)).toContain('anthropic/claude-sonnet-4')
  })
})

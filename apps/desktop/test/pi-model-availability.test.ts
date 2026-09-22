import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  catalogUsablePiModels,
  collectPiProviderProbe,
  formatPiCatalogError,
  parsePiModelRef,
  planPiLaunchModel,
  summarizePiModelIds,
} from '../src/main/chat/pi-model-availability.ts'

const anthropic = { provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' }
const spark = { provider: 'openai-codex', id: 'gpt-5.3-codex-spark', name: 'Codex Spark' }
const zai = { provider: 'zai', id: 'glm-4.6', name: 'GLM 4.6' }

describe('parsePiModelRef', () => {
  test('splits on the first slash so nested ids stay intact', () => {
    expect(parsePiModelRef('openrouter/deepseek/deepseek-v4-pro')).toEqual({
      provider: 'openrouter',
      id: 'deepseek/deepseek-v4-pro',
    })
  })

  test('rejects missing provider or id', () => {
    expect(parsePiModelRef('')).toBeNull()
    expect(parsePiModelRef('anthropic')).toBeNull()
    expect(parsePiModelRef('/claude')).toBeNull()
    expect(parsePiModelRef('anthropic/')).toBeNull()
  })
})

describe('collectPiProviderProbe', () => {
  test('keeps providers with a resolved key and captures the rest', () => {
    const probe = collectPiProviderProbe([
      { provider: 'openai-codex', apiKey: 'sk-test' },
      { provider: 'anthropic', apiKey: null, error: 'No API key for provider: anthropic' },
    ])
    expect([...probe.usable]).toEqual(['openai-codex'])
    expect(probe.errorByProvider.get('anthropic')).toBe('No API key for provider: anthropic')
    expect(probe.errors).toEqual(['No API key for provider: anthropic'])
  })
})

describe('catalogUsablePiModels', () => {
  test('drops providers whose credentials are not usable', () => {
    const models = catalogUsablePiModels(
      [anthropic, spark, zai],
      new Set(['openai-codex', 'zai']),
    )
    expect(models.map(model => model.id)).toEqual([
      'openai-codex/gpt-5.3-codex-spark',
      'zai/glm-4.6',
    ])
  })

  test('dedupes the same provider/id pair', () => {
    const models = catalogUsablePiModels([spark, spark], ['openai-codex'])
    expect(models).toEqual([{
      id: 'openai-codex/gpt-5.3-codex-spark',
      label: 'Codex Spark',
      description: 'openai-codex',
    }])
  })
})

describe('formatPiCatalogError', () => {
  test('is silent when usable models exist', () => {
    expect(formatPiCatalogError({
      models: catalogUsablePiModels([spark], ['openai-codex']),
      probeErrors: ['No API key for provider: anthropic'],
    })).toBeUndefined()
  })

  test('captures probe failures when nothing is usable', () => {
    expect(formatPiCatalogError({
      models: [],
      probeErrors: ['No API key for provider: anthropic'],
    })).toContain('No API key for provider: anthropic')
  })
})

describe('planPiLaunchModel', () => {
  const usable = catalogUsablePiModels([spark, zai], ['openai-codex', 'zai'])

  test('accepts a requested model that is actually usable', () => {
    expect(planPiLaunchModel({
      requested: 'openai-codex/gpt-5.3-codex-spark',
      usableModels: usable,
    })).toEqual({
      ok: true,
      ref: { provider: 'openai-codex', id: 'gpt-5.3-codex-spark' },
    })
  })

  test('fails closed with captured probe error and alternatives', () => {
    const plan = planPiLaunchModel({
      requested: 'anthropic/claude-sonnet-4-6',
      usableModels: usable,
      requestedProviderError: 'No API key for provider: anthropic',
    })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.error).toContain('anthropic/claude-sonnet-4-6')
    expect(plan.error).toContain('No API key for provider: anthropic')
    expect(plan.error).toContain('openai-codex/gpt-5.3-codex-spark')
    expect(plan.error).toContain('pi login anthropic')
  })

  test('fails closed when nothing is usable', () => {
    const plan = planPiLaunchModel({
      requested: 'anthropic/claude-sonnet-4-6',
      usableModels: [],
      requestedProviderError: 'Authentication failed for "anthropic"',
    })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.error).toContain('Authentication failed for "anthropic"')
    expect(plan.error).toContain('pi login anthropic')
  })

  test('rejects an empty selection when models exist', () => {
    const plan = planPiLaunchModel({ requested: '', usableModels: usable })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.error).toContain('No Pi model selected')
    expect(plan.error).toContain(summarizePiModelIds(usable))
  })
})

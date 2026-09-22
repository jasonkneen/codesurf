import { describe, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { expect } from './node-expect.ts'
import { DEFAULT_MODELS, getApproxContextWindowTokens } from '../src/renderer/src/config/providers.ts'

describe('Hermes provider model options', () => {
  test('tracks the current Hermes/Codex-first model picker defaults', () => {
    const hermesIds = DEFAULT_MODELS.hermes.map(model => model.id)

    expect(hermesIds[0]).toBe('openai-codex/gpt-5.6-sol')
    expect(hermesIds).toContain('openai-codex/gpt-5.6-terra')
    expect(hermesIds).toContain('openai-codex/gpt-5.6-luna')
    expect(hermesIds).toContain('openai-codex/gpt-5.5')
    expect(hermesIds).toContain('openai-codex/gpt-5.4-mini')
    expect(hermesIds).toContain('openai-codex/gpt-5.4')
    expect(hermesIds).toContain('anthropic/claude-opus-5')
    expect(hermesIds).toContain('anthropic/claude-opus-4-7')
    expect(hermesIds).toContain('anthropic/claude-sonnet-4-6')
    expect(hermesIds).toContain('openrouter/x-ai/grok-4.6')
    expect(hermesIds).toContain('gemini/gemini-3.1-pro-preview')
    expect(hermesIds).toContain('gemini/gemini-3-flash-preview')

    expect(hermesIds).not.toContain('openai/o4-mini')
    expect(hermesIds).not.toContain('google/gemini-2.5-pro')
  })

  test('estimates GPT-5.5 context correctly when routed through Hermes', () => {
    expect(getApproxContextWindowTokens('hermes', 'openai-codex/gpt-5.6-sol')).toBeGreaterThan(257_999)
    expect(getApproxContextWindowTokens('hermes', 'openai-codex/gpt-5.5')).toBeGreaterThan(257_999)
  })

  test('Claude and Codex pickers include Opus 5 and the GPT-5.6 Sol/Terra/Luna family', () => {
    expect(DEFAULT_MODELS.claude.map(model => model.id)).toContain('claude-opus-5')
    const codexIds = DEFAULT_MODELS.codex.map(model => model.id)
    expect(codexIds[0]).toBe('gpt-5.6-sol')
    expect(codexIds).toContain('gpt-5.6-terra')
    expect(codexIds).toContain('gpt-5.6-luna')
  })

  test('keeps legacy Kanban Hermes model suggestions aligned with the current default', () => {
    const source = readFileSync(`${process.cwd()}/src/renderer/src/components/KanbanCard.tsx`, 'utf8')

    expect(source).toContain("hermes:   ['openai-codex/gpt-5.6-sol'")
    expect(source).not.toContain("hermes:   ['anthropic/claude-opus-4-6'")
    expect(source).not.toContain("'openai/gpt-5.4'")
  })
})

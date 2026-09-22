import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getApproxContextWindowTokens } from '../src/renderer/src/config/providers.ts'

describe('getApproxContextWindowTokens — gateway models', () => {
  it('no longer under-reports vendor-prefixed Gemini as 128k', () => {
    assert.equal(getApproxContextWindowTokens('gateway', 'google/gemini-2.5-pro'), 1_000_000)
    assert.equal(getApproxContextWindowTokens('gateway', 'google/gemini-2.5-flash'), 1_000_000)
  })

  it('recognises vendor-prefixed Claude and GPT through the gateway', () => {
    assert.equal(getApproxContextWindowTokens('gateway', 'anthropic/claude-opus-5'), 200_000)
    assert.equal(getApproxContextWindowTokens('gateway', 'openai/gpt-5'), 258_000)
  })

  it('sizes the other gateway families by name', () => {
    assert.equal(getApproxContextWindowTokens('gateway', 'xai/grok-4'), 256_000)
    assert.equal(getApproxContextWindowTokens('gateway', 'meta/llama-3.3-70b'), 128_000)
    assert.equal(getApproxContextWindowTokens('gateway', 'mistral/mistral-large'), 128_000)
    assert.equal(getApproxContextWindowTokens('gateway', 'deepseek/deepseek-v3'), 128_000)
  })

  it('still falls back to 128k for a genuinely unknown model', () => {
    assert.equal(getApproxContextWindowTokens('gateway', 'someone/brand-new-model'), 128_000)
  })
})

describe('getApproxContextWindowTokens — existing behaviour preserved', () => {
  it('keeps the direct-provider answers unchanged', () => {
    assert.equal(getApproxContextWindowTokens('claude', 'claude-opus-5'), 200_000)
    assert.equal(getApproxContextWindowTokens('codex', 'gpt-5'), 258_000)
    assert.equal(getApproxContextWindowTokens('openai', 'o3-mini'), 200_000)
    assert.equal(getApproxContextWindowTokens('openai', 'gpt-5.1'), 258_000)
  })

  it('never returns a non-positive window', () => {
    for (const m of ['', 'x', 'gpt-5', 'google/gemini-2.5-pro', 'unknown']) {
      assert.ok(getApproxContextWindowTokens('gateway', m) > 0, `${m} must have a positive window`)
    }
  })
})

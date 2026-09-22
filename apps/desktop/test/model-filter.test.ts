import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import { matchesModelQuery, filterModels, DEFAULT_MODELS } from '../src/renderer/src/config/providers.ts'

describe('model search filter', () => {
  const opus = { id: 'claude-opus-4-8', label: 'Opus 4.8' }
  const sonnet = { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }
  const ocOpus = { id: 'anthropic/claude-opus-4-6', label: 'Opus 4.6' }
  const kimi = { id: 'openrouter/moonshotai/kimi-k2.6', label: 'Kimi K2.6', description: 'openrouter recommended' }

  test('empty query matches everything', () => {
    expect(matchesModelQuery(opus, '')).toBe(true)
    expect(matchesModelQuery(opus, '   ')).toBe(true)
    expect(filterModels([opus, sonnet], '').length).toBe(2)
  })

  test('multi-word query matches across separators in the id', () => {
    // "Opus 4.8".includes('claude opus') is false and 'claude-opus-4-8'.includes('claude opus')
    // is false (hyphen) — the old single-substring filter missed this; tokenised match catches it.
    expect(matchesModelQuery(opus, 'claude opus')).toBe(true)
    expect(matchesModelQuery(opus, 'opus 4.8')).toBe(true)
    expect(matchesModelQuery(opus, '4.8 opus')).toBe(true)
  })

  test('label-only tokens match', () => {
    expect(matchesModelQuery(sonnet, 'sonnet')).toBe(true)
    expect(matchesModelQuery(sonnet, 'SONNET 4.6')).toBe(true)
  })

  test('description tokens match', () => {
    expect(matchesModelQuery(kimi, 'kimi openrouter')).toBe(true)
  })

  test('a non-matching token excludes the model', () => {
    expect(matchesModelQuery(opus, 'opus gpt')).toBe(false)
    expect(matchesModelQuery(sonnet, 'opus')).toBe(false)
  })

  test('case-insensitive', () => {
    expect(matchesModelQuery(opus, 'OpUs')).toBe(true)
  })

  test('filterModels preserves original order and narrows the set', () => {
    const list = [opus, sonnet, ocOpus]
    const filtered = filterModels(list, 'opus')
    expect(filtered.map(m => m.id)).toEqual(['claude-opus-4-8', 'anthropic/claude-opus-4-6'])
  })

  test('works against the real claude catalog', () => {
    const hits = filterModels(DEFAULT_MODELS.claude, 'haiku')
    expect(hits.length).toBe(1)
    expect(hits[0].id).toBe('claude-haiku-4-5-20251001')
  })
})

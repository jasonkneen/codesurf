import { describe, it, expect, beforeEach } from 'vitest'
import { Indexer } from '../../lib/indexer.js'

const T0 = 1_730_000_000  // arbitrary epoch seconds

let idx
beforeEach(() => { idx = new Indexer({ now: () => T0, sessionWindowSec: 1800, halfLifeDays: 14 }) })

describe('Indexer', () => {
  it('starts with empty state', () => {
    const s = idx.getState()
    expect(s.files).toEqual({})
    expect(s.cooccurrence).toEqual({})
  })

  it('increments counters per tool', () => {
    idx.ingest({ tool: 'Read', path: 'a.ts', sessionId: 's1', ts: T0 })
    idx.ingest({ tool: 'Read', path: 'a.ts', sessionId: 's1', ts: T0 + 10 })
    idx.ingest({ tool: 'Edit', path: 'a.ts', sessionId: 's1', ts: T0 + 20 })
    idx.ingest({ tool: 'Write', path: 'a.ts', sessionId: 's1', ts: T0 + 30 })
    const f = idx.getState().files['a.ts']
    expect(f).toMatchObject({ reads: 2, edits: 1, writes: 1 })
    expect(f.lastTouched).toBe(T0 + 30)
  })

  it('records co-occurrence within session window', () => {
    idx.ingest({ tool: 'Read', path: 'a.ts', sessionId: 's1', ts: T0 })
    idx.ingest({ tool: 'Read', path: 'b.ts', sessionId: 's1', ts: T0 + 100 })
    idx.ingest({ tool: 'Read', path: 'c.ts', sessionId: 's1', ts: T0 + 200 })
    const co = idx.getState().cooccurrence
    expect(co['a.ts']['b.ts']).toBe(1)
    expect(co['b.ts']['a.ts']).toBe(1)
    expect(co['a.ts']['c.ts']).toBe(1)
  })

  it('does NOT increment co-occurrence twice for same pair within same session', () => {
    idx.ingest({ tool: 'Read', path: 'a.ts', sessionId: 's1', ts: T0 })
    idx.ingest({ tool: 'Read', path: 'b.ts', sessionId: 's1', ts: T0 + 60 })
    idx.ingest({ tool: 'Edit', path: 'a.ts', sessionId: 's1', ts: T0 + 120 })
    idx.ingest({ tool: 'Read', path: 'b.ts', sessionId: 's1', ts: T0 + 180 })
    expect(idx.getState().cooccurrence['a.ts']['b.ts']).toBe(1)
  })

  it('bumps co-occurrence again in a new session window', () => {
    idx.ingest({ tool: 'Read', path: 'a.ts', sessionId: 's1', ts: T0 })
    idx.ingest({ tool: 'Read', path: 'b.ts', sessionId: 's1', ts: T0 + 60 })
    // 31 minutes later — new session
    idx.ingest({ tool: 'Read', path: 'a.ts', sessionId: 's2', ts: T0 + 1860 })
    idx.ingest({ tool: 'Read', path: 'b.ts', sessionId: 's2', ts: T0 + 1920 })
    expect(idx.getState().cooccurrence['a.ts']['b.ts']).toBe(2)
  })

  it('hotness uses weighted decay (read=1, edit=3, write=5)', () => {
    idx.ingest({ tool: 'Write', path: 'a.ts', sessionId: 's1', ts: T0 })
    const h = idx.computeHotness('a.ts', T0)
    // Single Write event at age=0 → weight 5 × exp(0) = 5
    expect(h).toBeCloseTo(5, 5)
  })

  it('hotness decays with age', () => {
    idx.ingest({ tool: 'Read', path: 'a.ts', sessionId: 's1', ts: T0 })
    const fresh = idx.computeHotness('a.ts', T0)
    const halfLifeLater = idx.computeHotness('a.ts', T0 + 14 * 86400)
    expect(halfLifeLater).toBeLessThan(fresh)
    expect(halfLifeLater).toBeCloseTo(fresh * Math.exp(-1), 3)
  })

  it('survives serialize → deserialize round-trip', () => {
    idx.ingest({ tool: 'Read', path: 'a.ts', sessionId: 's1', ts: T0 })
    idx.ingest({ tool: 'Edit', path: 'b.ts', sessionId: 's1', ts: T0 + 60 })
    const dumped = idx.serialize()
    const restored = new Indexer({ now: () => T0 + 100 })
    restored.deserialize(dumped)
    expect(restored.getState().files['a.ts'].reads).toBe(1)
    expect(restored.getState().files['b.ts'].edits).toBe(1)
    expect(restored.getState().cooccurrence['a.ts']['b.ts']).toBe(1)
  })

  it('updateSymbols replaces a file symbol list', () => {
    idx.ingest({ tool: 'Edit', path: 'a.ts', sessionId: 's1', ts: T0 })
    idx.updateSymbols('a.ts', { language: 'typescript', size: 100, symbols: [{ name: 'foo', kind: 'function', line: 1 }], parseError: null })
    expect(idx.getState().files['a.ts'].symbols).toHaveLength(1)
    idx.updateSymbols('a.ts', { language: 'typescript', size: 200, symbols: [{ name: 'bar', kind: 'class', line: 5 }], parseError: null })
    expect(idx.getState().files['a.ts'].symbols[0].name).toBe('bar')
  })

  it('parseError is stored and clears on success', () => {
    idx.ingest({ tool: 'Edit', path: 'a.ts', sessionId: 's1', ts: T0 })
    idx.updateSymbols('a.ts', { language: 'typescript', size: 100, symbols: [], parseError: 'syntax' })
    expect(idx.getState().files['a.ts'].parseError).toBe('syntax')
    idx.updateSymbols('a.ts', { language: 'typescript', size: 100, symbols: [{ name: 'x', kind: 'function', line: 1 }], parseError: null })
    expect(idx.getState().files['a.ts'].parseError).toBeNull()
  })
})

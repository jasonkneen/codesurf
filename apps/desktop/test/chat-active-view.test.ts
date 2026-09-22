import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import { normalizeActiveView } from '../src/renderer/src/components/chat/chatTileTypes.ts'

describe('normalizeActiveView', () => {
  test('defaults to chat when the value is absent or unknown', () => {
    expect(normalizeActiveView(undefined)).toBe('chat')
    expect(normalizeActiveView(null)).toBe('chat')
    expect(normalizeActiveView('')).toBe('chat')
    expect(normalizeActiveView('something-else')).toBe('chat')
    expect(normalizeActiveView(42)).toBe('chat')
  })

  test('passes through the two valid views', () => {
    expect(normalizeActiveView('chat')).toBe('chat')
    expect(normalizeActiveView('terminal')).toBe('terminal')
  })

  test('survives a persist -> load round-trip via the persisted shape', () => {
    // Mirrors how the persistence hook reads the field: a saved state object is
    // read back as Partial<ChatTilePersistedState> and coerced on load.
    for (const view of ['chat', 'terminal'] as const) {
      const saved = JSON.parse(JSON.stringify({ activeView: view })) as { activeView?: unknown }
      expect(normalizeActiveView(saved.activeView)).toBe(view)
    }
  })

  test('legacy state with no activeView field loads as chat', () => {
    const legacy = JSON.parse(JSON.stringify({ messages: [], input: '' })) as { activeView?: unknown }
    expect(normalizeActiveView(legacy.activeView)).toBe('chat')
  })
})

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AppSettings } from '../src/shared/types.ts'
import {
  persistGenerationKeys,
  resolveGenerationKeys,
  generationSecretName,
} from '../src/main/generation-secrets.ts'

function makeStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    setSecret(name: string, value: string) { map.set(name, value) },
    getSecret(name: string) { return map.get(name) ?? null },
  }
}

// Only `generationProviders` is touched; build a minimal settings shape.
function settingsWith(providers: Record<string, { id: string; apiKey: string }>): AppSettings {
  return { generationProviders: providers } as unknown as AppSettings
}

describe('persistGenerationKeys', () => {
  test('moves a plaintext key into the store and blanks the field', () => {
    const store = makeStore()
    const { settings, migrated } = persistGenerationKeys(
      settingsWith({ gemini: { id: 'gemini', apiKey: 'sk-secret-123' } }),
      store,
    )
    assert.equal(migrated, 1)
    assert.equal(settings.generationProviders.gemini.apiKey, '')
    assert.equal(store.map.get(generationSecretName('gemini')), 'sk-secret-123')
  })

  test('is idempotent — already-blank providers are untouched', () => {
    const store = makeStore()
    const { migrated } = persistGenerationKeys(
      settingsWith({ gemini: { id: 'gemini', apiKey: '' } }),
      store,
    )
    assert.equal(migrated, 0)
    assert.equal(store.map.size, 0)
  })

  test('migrates only the providers that carry a key', () => {
    const store = makeStore()
    const { migrated, settings } = persistGenerationKeys(
      settingsWith({
        gemini: { id: 'gemini', apiKey: 'k1' },
        openai: { id: 'openai', apiKey: '' },
        anthropic: { id: 'anthropic', apiKey: '  ' }, // whitespace-only → treated as blank
      }),
      store,
    )
    assert.equal(migrated, 1)
    assert.equal(settings.generationProviders.gemini.apiKey, '')
    assert.equal(store.map.size, 1)
  })

  test('no generationProviders is a safe no-op', () => {
    const store = makeStore()
    const result = persistGenerationKeys({} as AppSettings, store)
    assert.equal(result.migrated, 0)
  })

  test('a store failure aborts before the key is blanked (no data loss)', () => {
    const throwingStore = {
      setSecret() { throw new Error('keychain unavailable') },
      getSecret() { return null },
    }
    assert.throws(
      () => persistGenerationKeys(settingsWith({ gemini: { id: 'gemini', apiKey: 'k1' } }), throwingStore),
      /keychain unavailable/,
    )
  })
})

describe('resolveGenerationKeys', () => {
  test('fills a blank field from the store', () => {
    const store = makeStore({ [generationSecretName('gemini')]: 'sk-secret-123' })
    const resolved = resolveGenerationKeys(
      settingsWith({ gemini: { id: 'gemini', apiKey: '' } }),
      store,
    )
    assert.equal(resolved.generationProviders.gemini.apiKey, 'sk-secret-123')
  })

  test('leaves an already-populated field as-is (does not override from store)', () => {
    const store = makeStore({ [generationSecretName('gemini')]: 'stored' })
    const resolved = resolveGenerationKeys(
      settingsWith({ gemini: { id: 'gemini', apiKey: 'inline' } }),
      store,
    )
    assert.equal(resolved.generationProviders.gemini.apiKey, 'inline')
  })

  test('leaves the field blank when the store has no secret', () => {
    const resolved = resolveGenerationKeys(
      settingsWith({ gemini: { id: 'gemini', apiKey: '' } }),
      makeStore(),
    )
    assert.equal(resolved.generationProviders.gemini.apiKey, '')
  })
})

describe('persist → resolve round-trip', () => {
  test('recovers the original key for in-process consumption', () => {
    const store = makeStore()
    const { settings: persisted } = persistGenerationKeys(
      settingsWith({ gemini: { id: 'gemini', apiKey: 'round-trip-key' } }),
      store,
    )
    // settings.json holds no plaintext...
    assert.equal(persisted.generationProviders.gemini.apiKey, '')
    // ...but the consumer view recovers it from the keychain.
    const resolved = resolveGenerationKeys(persisted, store)
    assert.equal(resolved.generationProviders.gemini.apiKey, 'round-trip-key')
  })
})

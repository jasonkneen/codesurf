import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { redactSettingsForCache } from '../src/renderer/src/lib/appShellPersistence.ts'
import { DEFAULT_SETTINGS, type AppSettings } from '../src/shared/types.ts'

function settingsWithKeys(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    omnigent: { ...DEFAULT_SETTINGS.omnigent, apiKey: 'omni-secret-key' },
    generationProviders: {
      openai: {
        ...DEFAULT_SETTINGS.generationProviders.openai,
        apiKey: 'sk-live-do-not-persist',
      },
      replicate: {
        ...DEFAULT_SETTINGS.generationProviders.replicate,
        apiKey: 'r8-live-do-not-persist',
      },
    },
  }
}

describe('redactSettingsForCache', () => {
  it('removes every provider apiKey', () => {
    const out = redactSettingsForCache(settingsWithKeys())
    assert.equal(out.generationProviders.openai.apiKey, '')
    assert.equal(out.generationProviders.replicate.apiKey, '')
  })

  it('removes the omnigent apiKey', () => {
    assert.equal(redactSettingsForCache(settingsWithKeys()).omnigent.apiKey, '')
  })

  it('leaves no secret anywhere in the serialized cache payload', () => {
    const serialized = JSON.stringify(redactSettingsForCache(settingsWithKeys()))
    for (const secret of ['sk-live-do-not-persist', 'r8-live-do-not-persist', 'omni-secret-key']) {
      assert.equal(serialized.includes(secret), false, `${secret} must not reach localStorage`)
    }
  })

  it('preserves non-secret provider configuration', () => {
    const input = settingsWithKeys()
    const out = redactSettingsForCache(input)
    assert.equal(out.generationProviders.openai.enabled, input.generationProviders.openai.enabled)
    assert.equal(out.generationProviders.openai.label, input.generationProviders.openai.label)
    assert.deepEqual(out.theme, input.theme)
  })

  it('does not mutate the caller’s settings object', () => {
    const input = settingsWithKeys()
    redactSettingsForCache(input)
    assert.equal(input.generationProviders.openai.apiKey, 'sk-live-do-not-persist')
    assert.equal(input.omnigent.apiKey, 'omni-secret-key')
  })
})

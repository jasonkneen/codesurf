/**
 * gap-03: keep generation-provider API keys out of plaintext `settings.json`.
 *
 * Image/video generation provider keys used to live in
 * `settings.generationProviders[id].apiKey` and were persisted as plaintext
 * JSON — unlike TTS/STT/spokify keys, which already route through the OS
 * keychain via `safeStorage` (`secrets.ts`). This module moves generation keys
 * onto the same keychain path: `persistGenerationKeys` stores each key under
 * `generation:<id>` and blanks the field before persistence;
 * `resolveGenerationKeys` re-fills the field from the keychain for in-process
 * consumption and the settings UI. settings.json then holds no plaintext key.
 *
 * The secret store is injected so the split is unit-testable without Electron
 * (`test/generation-secrets.test.ts`); the SettingsPanel display behavior is the
 * runtime tail to verify in-app.
 */

import type { AppSettings, GenerationProviderSettings } from '../shared/types'

export const GENERATION_SECRET_PREFIX = 'generation:'

export interface GenerationSecretStore {
  setSecret(name: string, value: string): void
  getSecret(name: string): string | null
}

// The real store wraps `./secrets` (Electron `safeStorage`), which can't be
// imported under `node --test`. So the main process injects it once at startup
// via `setGenerationSecretStore`, keeping this module electron-free + testable.
// Tests pass a store explicitly as the optional second arg.
let activeStore: GenerationSecretStore | null = null

export function setGenerationSecretStore(store: GenerationSecretStore): void {
  activeStore = store
}

function requireStore(explicit?: GenerationSecretStore): GenerationSecretStore {
  const store = explicit ?? activeStore
  if (!store) throw new Error('generation secret store is not initialized')
  return store
}

export function generationSecretName(providerId: string): string {
  return `${GENERATION_SECRET_PREFIX}${providerId}`
}

// Move any plaintext provider apiKey into the secret store, then blank the field
// in the returned settings so the persisted JSON holds no plaintext key. The
// key is only blanked AFTER `setSecret` returns, so a store failure can't lose
// it (the exception aborts the whole save). Idempotent — already-blank providers
// are untouched. Returns the sanitized settings plus how many keys moved.
export function persistGenerationKeys(
  settings: AppSettings,
  storeOverride?: GenerationSecretStore,
): { settings: AppSettings; migrated: number } {
  const providers = settings.generationProviders
  if (!providers) return { settings, migrated: 0 }
  const store = requireStore(storeOverride)

  let migrated = 0
  const nextProviders: Record<string, GenerationProviderSettings> = {}
  for (const [id, provider] of Object.entries(providers)) {
    const key = typeof provider?.apiKey === 'string' ? provider.apiKey.trim() : ''
    if (key) {
      store.setSecret(generationSecretName(id), key)
      migrated += 1
      nextProviders[id] = { ...provider, apiKey: '' }
    } else {
      nextProviders[id] = provider
    }
  }
  return { settings: { ...settings, generationProviders: nextProviders }, migrated }
}

// Fill each provider's apiKey from the keychain when the field is currently
// blank (i.e. persisted as a keychain-backed reference). Returns settings with
// real keys for in-process generation + the settings UI.
export function resolveGenerationKeys(
  settings: AppSettings,
  storeOverride?: GenerationSecretStore,
): AppSettings {
  const providers = settings.generationProviders
  if (!providers) return settings
  const store = requireStore(storeOverride)

  const nextProviders: Record<string, GenerationProviderSettings> = {}
  for (const [id, provider] of Object.entries(providers)) {
    const current = typeof provider?.apiKey === 'string' ? provider.apiKey : ''
    if (!current.trim()) {
      const secret = store.getSecret(generationSecretName(id))
      nextProviders[id] = secret ? { ...provider, apiKey: secret } : provider
    } else {
      nextProviders[id] = provider
    }
  }
  return { ...settings, generationProviders: nextProviders }
}

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { chatModelCatalogPayload } from '../bin/chat-model-catalog.mjs'

function homeWithCodexCache(models) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-home-'))
  fs.mkdirSync(path.join(home, '.codex'))
  fs.writeFileSync(path.join(home, '.codex', 'models_cache.json'), JSON.stringify({ models }))
  return home
}

test('codex models come from the live codex cache, listed-only, in priority order', () => {
  const home = homeWithCodexCache([
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', priority: 4 },
    { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 3 },
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', priority: 1 },
  ])
  const { providers } = chatModelCatalogPayload({ homeDir: home })
  const codex = providers.find(p => p.id === 'codex')
  assert.deepEqual(codex.models.map(m => m.id), ['gpt-6-astra', 'gpt-5.6-sol'])
  const hermes = providers.find(p => p.id === 'hermes')
  assert.equal(hermes.models[0].id, 'openai-codex/gpt-6-astra')
  assert.ok(!hermes.models.some(m => m.id === 'openai-codex/gpt-5.4'))
})

test('falls back to the static catalog without a codex cache, with current Claude models', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-empty-'))
  const { providers } = chatModelCatalogPayload({ homeDir: home })
  const claude = providers.find(p => p.id === 'claude').models.map(m => m.id)
  const codex = providers.find(p => p.id === 'codex').models.map(m => m.id)
  const hermes = providers.find(p => p.id === 'hermes').models.map(m => m.id)
  assert.ok(claude.includes('claude-fable-5-1'))
  assert.ok(claude.includes('claude-opus-5-5'))
  assert.ok(claude.includes('claude-sonnet-5-5'))
  assert.ok(claude.includes('claude-haiku-5-5'))
  assert.ok(codex.includes('gpt-6-sol'))
  assert.ok(codex.includes('gpt-6-luna'))
  assert.ok(hermes.includes('openai-codex/gpt-6-sol'))
  assert.ok(hermes.includes('openai-codex/gpt-6-luna'))
})

test('serves context windows so clients never guess Claude models at 200k', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-empty-'))
  const { providers } = chatModelCatalogPayload({ homeDir: home })
  const window = id => providers.find(p => p.id === 'claude').models.find(m => m.id === id)?.contextWindow
  assert.equal(window('claude-opus-5-5'), 1_000_000)
  assert.equal(window('claude-sonnet-5-5'), 1_000_000)
  assert.equal(window('claude-haiku-5-5'), 1_000_000)
  assert.equal(window('claude-haiku-4-5-20251001'), 200_000)

  const cached = homeWithCodexCache([{ slug: 'gpt-6-sol', visibility: 'list', priority: 1, context_window: 272000 }])
  const codex = chatModelCatalogPayload({ homeDir: cached }).providers.find(p => p.id === 'codex')
  assert.equal(codex.models[0].contextWindow, 272000)
})

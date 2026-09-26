import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Chat model catalog served at GET /chat/model-catalog.
//
// Lives in the canonical daemon so every host sees the same catalog no matter
// which one started the shared process. It used to be injected by the CLI's
// launcher wrapper, so the route existed only when the CLI happened to spawn
// the daemon and silently vanished when the desktop app did.

export const CHAT_MODEL_CATALOG = [
  {
    id: 'claude',
    provider: 'claude',
    label: 'Claude',
    models: [
      { id: 'claude-fable-5-1', label: 'Fable 5.1' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    ],
  },
  {
    id: 'codex',
    provider: 'codex',
    label: 'Codex',
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.1-codex-mini', label: 'Codex Mini' },
      { id: 'gpt-5.3-codex', label: 'Codex 5.3' },
      { id: 'o4-mini', label: 'o4-mini' },
      { id: 'o3', label: 'o3' },
      { id: 'o3-mini', label: 'o3-mini' },
    ],
  },
  {
    id: 'opencode',
    provider: 'opencode',
    label: 'OpenCode',
    models: [
      { id: 'anthropic/claude-fable-5-1', label: 'Fable 5.1' },
      { id: 'anthropic/claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'anthropic/claude-sonnet-5', label: 'Sonnet 5' },
      { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
      { id: 'openai/o4-mini', label: 'o4-mini' },
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    ],
  },
  {
    id: 'hermes',
    provider: 'hermes',
    label: 'Hermes',
    models: [
      { id: 'openai-codex/gpt-5.5', label: 'GPT-5.5' },
      { id: 'openai-codex/gpt-5.4-mini', label: 'GPT-5.4 Mini' },
      { id: 'openai-codex/gpt-5.4', label: 'GPT-5.4' },
      { id: 'openai-codex/gpt-5.3-codex', label: 'Codex 5.3' },
      { id: 'openai-codex/gpt-5.1-codex-max', label: 'Codex Max' },
      { id: 'openai-codex/gpt-5.1-codex-mini', label: 'Codex Mini' },
      { id: 'anthropic/claude-fable-5-1', label: 'Fable 5.1' },
      { id: 'anthropic/claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'anthropic/claude-sonnet-5', label: 'Sonnet 5' },
      { id: 'anthropic/claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
      { id: 'gemini/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
      { id: 'gemini/gemini-3-pro-preview', label: 'Gemini 3 Pro' },
      { id: 'gemini/gemini-3-flash-preview', label: 'Gemini 3 Flash' },
      { id: 'openrouter/moonshotai/kimi-k2.6', label: 'Kimi K2.6', description: 'openrouter recommended' },
      { id: 'openrouter/deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'openrouter' },
      { id: 'openrouter/qwen/qwen3.6-plus', label: 'Qwen 3.6 Plus', description: 'openrouter' },
    ],
  },
]

/**
 * Codex models as the Codex CLI itself last fetched them
 * (~/.codex/models_cache.json, refreshed by codex). Only `visibility: list`
 * entries, in Codex's own priority order. Null when the cache is missing or
 * unreadable — callers keep the static list.
 */
export function readCodexModelCache(homeDir = os.homedir()) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(homeDir, '.codex', 'models_cache.json'), 'utf8'))
    const models = (Array.isArray(raw?.models) ? raw.models : [])
      .filter(m => typeof m?.slug === 'string' && m.slug && m.visibility !== 'hide')
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map(m => ({
        id: m.slug,
        label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.slug,
        ...(typeof m.description === 'string' && m.description ? { description: m.description } : {}),
      }))
    return models.length > 0 ? models : null
  } catch {
    return null
  }
}

export function chatModelCatalogPayload({ homeDir } = {}) {
  const codexModels = readCodexModelCache(homeDir)
  if (!codexModels) return { version: 1, providers: CHAT_MODEL_CATALOG }
  const providers = CHAT_MODEL_CATALOG.map((provider) => {
    if (provider.id === 'codex') return { ...provider, models: codexModels }
    if (provider.id === 'hermes') {
      // Hermes routes OpenAI through its openai-codex/ namespace; keep its
      // other providers and swap in the live Codex lineup.
      const others = provider.models.filter(m => !m.id.startsWith('openai-codex/'))
      return {
        ...provider,
        models: [...codexModels.map(m => ({ ...m, id: `openai-codex/${m.id}` })), ...others],
      }
    }
    return provider
  })
  return { version: 1, providers }
}

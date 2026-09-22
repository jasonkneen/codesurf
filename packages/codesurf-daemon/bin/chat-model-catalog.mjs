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
      { id: 'claude-opus-4-7', label: 'Opus 4.7' },
      { id: 'claude-opus-4-6', label: 'Opus 4.6' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
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
      { id: 'anthropic/claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'anthropic/claude-opus-4-6', label: 'Opus 4.6' },
      { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
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
      { id: 'anthropic/claude-opus-4-7', label: 'Opus 4.7' },
      { id: 'anthropic/claude-opus-4-6', label: 'Opus 4.6' },
      { id: 'anthropic/claude-sonnet-4-6', label: 'Sonnet 4.6' },
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

export function chatModelCatalogPayload() {
  return { version: 1, providers: CHAT_MODEL_CATALOG }
}

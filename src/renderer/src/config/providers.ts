/** Chat provider/model/mode configuration — extracted from ChatTile for reuse. */

export type BuiltinProvider = 'claude' | 'codex' | 'opencode' | 'openclaw' | 'hermes' | 'omnigent' | 'csagent' | 'gateway'

export interface ModelOption {
  id: string
  label: string
  description?: string
}

export interface ModeOption {
  id: string
  label: string
  description: string
  color: string
}

export interface ThinkingOption {
  id: string
  label: string
  description: string
}

export const DEFAULT_MODELS: Record<BuiltinProvider, ModelOption[]> = {
  claude: [
    { id: 'claude-fable-5', label: 'Fable 5' },
    { id: 'claude-opus-5', label: 'Opus 5' },
    { id: 'claude-opus-4-8', label: 'Opus 4.8' },
    { id: 'claude-opus-4-7', label: 'Opus 4.7' },
    { id: 'claude-opus-4-6', label: 'Opus 4.6' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ],
  codex: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.1-codex-mini', label: 'Codex Mini' },
    { id: 'gpt-5.3-codex', label: 'Codex 5.3' },
    { id: 'o4-mini', label: 'o4-mini' },
    { id: 'o3', label: 'o3' },
    { id: 'o3-mini', label: 'o3-mini' },
  ],
  opencode: [
    { id: 'anthropic/claude-opus-5', label: 'Opus 5' },
    { id: 'anthropic/claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'anthropic/claude-opus-4-6', label: 'Opus 4.6' },
    { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
    { id: 'openai/o4-mini', label: 'o4-mini' },
    { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
  openclaw: [
    { id: 'main', label: 'Main (default)', description: 'Configured default OpenClaw agent' },
  ],
  hermes: [
    { id: 'openai-codex/gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'openai-codex/gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'openai-codex/gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'openai-codex/gpt-5.5', label: 'GPT-5.5' },
    { id: 'openai-codex/gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { id: 'openai-codex/gpt-5.4', label: 'GPT-5.4' },
    { id: 'openai-codex/gpt-5.3-codex', label: 'Codex 5.3' },
    { id: 'openai-codex/gpt-5.1-codex-max', label: 'Codex Max' },
    { id: 'openai-codex/gpt-5.1-codex-mini', label: 'Codex Mini' },
    { id: 'anthropic/claude-opus-5', label: 'Opus 5' },
    { id: 'anthropic/claude-opus-4-8', label: 'Opus 4.8' },
    { id: 'anthropic/claude-opus-4-7', label: 'Opus 4.7' },
    { id: 'anthropic/claude-opus-4-6', label: 'Opus 4.6' },
    { id: 'anthropic/claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'anthropic/claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    { id: 'gemini/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
    { id: 'gemini/gemini-3-pro-preview', label: 'Gemini 3 Pro' },
    { id: 'gemini/gemini-3-flash-preview', label: 'Gemini 3 Flash' },
    { id: 'openrouter/x-ai/grok-4.6', label: 'Grok 4.6', description: 'openrouter' },
    { id: 'openrouter/moonshotai/kimi-k2.6', label: 'Kimi K2.6', description: 'openrouter recommended' },
    { id: 'openrouter/deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'openrouter' },
    { id: 'openrouter/qwen/qwen3.6-plus', label: 'Qwen 3.6 Plus', description: 'openrouter' },
  ],
  omnigent: [
    { id: 'omnigent:default', label: 'Default agent', description: 'Configured/default Omnigent agent' },
  ],
  csagent: [
    { id: 'anthropic/claude-sonnet-4-6', label: 'Sonnet 4.6' },
  ],
  gateway: [
    { id: 'anthropic/claude-opus-5', label: 'Opus 5' },
    { id: 'anthropic/claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'anthropic/claude-haiku-4-5', label: 'Haiku 4.5' },
    { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
    { id: 'openai/o4-mini', label: 'o4-mini' },
    { id: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
    { id: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash' },
    { id: 'xai/grok-4.6', label: 'Grok 4.6' },
    { id: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6' },
    { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    { id: 'zai/glm-5', label: 'GLM-5' },
  ],
}

export const DEFAULT_PROVIDER_ID: BuiltinProvider = 'claude'

export const PROVIDER_MODES: Record<BuiltinProvider, ModeOption[]> = {
  claude: [
    { id: 'default', label: 'Default', description: 'Ask before risky actions', color: '#3fb950' },
    { id: 'acceptEdits', label: 'Accept Edits', description: 'Auto-approve file edits', color: '#ffb432' },
    { id: 'plan', label: 'Plan', description: 'Plan only, no execution', color: '#58a6ff' },
    { id: 'bypassPermissions', label: 'Bypass', description: 'Full auto, no approval', color: '#e54d2e' },
  ],
  codex: [
    { id: 'default', label: 'Default', description: 'Ask before risky actions', color: '#3fb950' },
    { id: 'auto', label: 'Auto', description: 'Auto-approve safe actions', color: '#ffb432' },
    { id: 'read-only', label: 'Read Only', description: 'No file modifications', color: '#58a6ff' },
    { id: 'full-access', label: 'Full Access', description: 'Full auto, no approval', color: '#e54d2e' },
  ],
  opencode: [
    { id: 'default', label: 'Default', description: 'Ask before risky actions', color: '#3fb950' },
    { id: 'plan', label: 'Plan', description: 'Plan only, no execution', color: '#58a6ff' },
    { id: 'bypassPermissions', label: 'Bypass', description: 'Full auto, no approval', color: '#e54d2e' },
  ],
  openclaw: [
    { id: 'default', label: 'Default', description: 'Ask before risky actions', color: '#3fb950' },
    { id: 'auto', label: 'Auto', description: 'Auto-approve safe actions', color: '#ffb432' },
    { id: 'plan', label: 'Plan', description: 'Plan only, no execution', color: '#58a6ff' },
    { id: 'full-auto', label: 'Full Auto', description: 'Full auto, no approval', color: '#e54d2e' },
  ],
  hermes: [
    { id: 'full', label: 'Full', description: 'All toolsets enabled', color: '#e54d2e' },
    { id: 'terminal', label: 'Terminal', description: 'Terminal + file tools', color: '#ffb432' },
    { id: 'web', label: 'Web', description: 'Web + browser tools', color: '#3fb950' },
    { id: 'query', label: 'Query', description: 'No tools, query only', color: '#58a6ff' },
  ],
  omnigent: [
    { id: 'default', label: 'Default', description: 'Use Omnigent agent defaults', color: '#3fb950' },
  ],
  csagent: [
    { id: 'default', label: 'Default', description: 'Ask before risky actions', color: '#3fb950' },
    { id: 'bypass', label: 'Bypass', description: 'Full auto, no approval', color: '#e54d2e' },
  ],
  gateway: [
    { id: 'default', label: 'Chat', description: 'Streaming chat with canvas tools', color: '#3fb950' },
  ],
}

export const EXTENSION_PROVIDER_MODE: ModeOption = {
  id: 'proxy',
  label: 'Proxy',
  description: 'Connected extension transport',
  color: '#58a6ff',
}

export function getProviderModeOptions(providerId: string): ModeOption[] {
  return isBuiltinProvider(providerId)
    ? PROVIDER_MODES[providerId]
    : [EXTENSION_PROVIDER_MODE]
}

export function resolveProviderModeId(providerId: string, preferredModeId?: string | null): string {
  const options = getProviderModeOptions(providerId)
  const preferred = typeof preferredModeId === 'string' ? preferredModeId.trim() : ''
  return options.find(option => option.id === preferred)?.id
    ?? options[0]?.id
    ?? EXTENSION_PROVIDER_MODE.id
}

export const THINKING_OPTIONS: ThinkingOption[] = [
  { id: 'adaptive', label: 'Adaptive', description: 'Model decides when to think' },
  { id: 'none', label: 'Off', description: 'No extended thinking' },
  { id: 'low', label: 'Low', description: '~2K tokens budget' },
  { id: 'medium', label: 'Medium', description: '~8K tokens budget' },
  { id: 'high', label: 'High', description: '~32K tokens budget' },
  { id: 'max', label: 'Max', description: '~128K tokens budget' },
]

export const PROVIDER_LABELS: Record<BuiltinProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  omnigent: 'Omnigent',
  csagent: 'Pi',
  gateway: 'AI Gateway',
}

export function isBuiltinProvider(providerId: string): providerId is BuiltinProvider {
  return providerId === 'claude'
    || providerId === 'codex'
    || providerId === 'opencode'
    || providerId === 'openclaw'
    || providerId === 'hermes'
    || providerId === 'omnigent'
    || providerId === 'csagent'
    || providerId === 'gateway'
}

export function getApproxContextWindowTokens(providerId: string, modelId: string): number {
  const normalizedModel = modelId.toLowerCase()
  const normalizedProvider = providerId.toLowerCase()

  if (/gpt-5(?:\.|-|$)/.test(normalizedModel)) return 258_000
  if (normalizedModel.includes('o3') || normalizedModel.includes('o4')) return 200_000
  if (normalizedProvider === 'claude' || normalizedModel.includes('claude')) return 200_000
  if (normalizedProvider === 'codex') return 258_000
  return 128_000
}

/**
 * Rough estimate of the "invisible" tokens each provider's harness loads into
 * context before any user messages — system prompt, tool schemas, injected
 * safety reminders, MCP tool definitions, etc.
 *
 * These numbers are deliberately conservative approximations based on
 * measured payloads (e.g. the Claude Code binary ships a ~27k system prompt
 * plus tool schemas, so ~32k is a reasonable floor). They let the context
 * usage indicator reflect real utilisation instead of only counting the
 * user-visible turn content.
 */
export function getApproxSystemOverheadTokens(providerId: string, modelId: string): number {
  const normalizedProvider = providerId.toLowerCase()
  const normalizedModel = modelId.toLowerCase()

  // AI Gateway: system prompt + canvas MCP tool schemas (no CLI harness).
  if (normalizedProvider === 'gateway') return 8_000
  // Claude Code harness: ~27k system prompt + ~5k tool schemas + reminders.
  if (normalizedProvider === 'claude' || normalizedModel.includes('claude')) return 32_000
  // Codex CLI harness: comparable footprint, slightly leaner tool schemas.
  if (normalizedProvider === 'codex' || normalizedModel.includes('gpt-5')) return 18_000
  // OpenCode / OpenClaw / Hermes — lighter harnesses.
  if (normalizedProvider === 'opencode') return 12_000
  if (normalizedProvider === 'openclaw') return 12_000
  if (normalizedProvider === 'hermes') return 8_000
  if (normalizedProvider === 'omnigent') return 8_000
  return 6_000
}

/**
 * Tokenised substring match for model search: every whitespace-separated token
 * in the query must appear somewhere in the model's label, id, or description
 * (case-insensitive). Unlike a single `includes`, this matches multi-word queries
 * across separators — e.g. "claude opus" matches the model id `claude-opus-4-8`,
 * and "4.8 opus" matches "Opus 4.8".
 *
 * Algorithm adapted from Helmor's `scoreModel` (Apache-2.0).
 */
export function matchesModelQuery(model: ModelOption, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = `${model.label} ${model.id} ${model.description ?? ''}`.toLowerCase()
  for (const token of q.split(/\s+/)) {
    if (!haystack.includes(token)) return false
  }
  return true
}

/** Filter a model list by a free-text query, preserving the original order. */
export function filterModels(models: ModelOption[], query: string): ModelOption[] {
  if (!query.trim()) return models
  return models.filter(model => matchesModelQuery(model, query))
}

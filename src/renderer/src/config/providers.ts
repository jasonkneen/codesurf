/** Chat provider/model/mode configuration — extracted from ChatTile for reuse. */

export type BuiltinProvider = 'claude' | 'codex' | 'opencode' | 'openclaw' | 'hermes'

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
    { id: 'claude-opus-4-7', label: 'Opus 4.7' },
    { id: 'claude-opus-4-6', label: 'Opus 4.6' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ],
  codex: [
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.1-codex-mini', label: 'Codex Mini' },
    { id: 'gpt-5.3-codex', label: 'Codex 5.3' },
    { id: 'o4-mini', label: 'o4-mini' },
    { id: 'o3', label: 'o3' },
    { id: 'o3-mini', label: 'o3-mini' },
  ],
  opencode: [
    { id: 'anthropic/claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'anthropic/claude-opus-4-6', label: 'Opus 4.6' },
    { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
    { id: 'openai/o4-mini', label: 'o4-mini' },
    { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
  openclaw: [
    { id: 'main', label: 'Main (default)', description: 'Configured default OpenClaw agent' },
  ],
  hermes: [
    { id: 'anthropic/claude-opus-4-6', label: 'Opus 4.6' },
    { id: 'anthropic/claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
    { id: 'openai/o4-mini', label: 'o4-mini' },
    { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
}

export const DEFAULT_PROVIDER_ID: BuiltinProvider = 'claude'

export const PROVIDER_MODES: Record<BuiltinProvider, ModeOption[]> = {
  claude: [
    { id: 'bypassPermissions', label: 'Bypass', description: 'Full auto, no approval', color: '#e54d2e' },
    { id: 'acceptEdits', label: 'Accept Edits', description: 'Auto-approve file edits', color: '#ffb432' },
    { id: 'default', label: 'Default', description: 'Ask before risky actions', color: '#3fb950' },
    { id: 'plan', label: 'Plan', description: 'Plan only, no execution', color: '#58a6ff' },
  ],
  codex: [
    { id: 'full-access', label: 'Full Access', description: 'Full auto, no approval', color: '#e54d2e' },
    { id: 'auto', label: 'Auto', description: 'Auto-approve safe actions', color: '#ffb432' },
    { id: 'read-only', label: 'Read Only', description: 'No file modifications', color: '#58a6ff' },
  ],
  opencode: [
    { id: 'plan', label: 'Plan', description: 'Plan only, no execution', color: '#58a6ff' },
    { id: 'build', label: 'Build', description: 'Execute and build code', color: '#ffb432' },
  ],
  openclaw: [
    { id: 'full-auto', label: 'Full Auto', description: 'Full auto, no approval', color: '#e54d2e' },
    { id: 'auto', label: 'Auto', description: 'Auto-approve safe actions', color: '#ffb432' },
    { id: 'default', label: 'Default', description: 'Ask before risky actions', color: '#3fb950' },
    { id: 'plan', label: 'Plan', description: 'Plan only, no execution', color: '#58a6ff' },
  ],
  hermes: [
    { id: 'full', label: 'Full', description: 'All toolsets enabled', color: '#e54d2e' },
    { id: 'terminal', label: 'Terminal', description: 'Terminal + file tools', color: '#ffb432' },
    { id: 'web', label: 'Web', description: 'Web + browser tools', color: '#3fb950' },
    { id: 'query', label: 'Query', description: 'No tools, query only', color: '#58a6ff' },
  ],
}

export const EXTENSION_PROVIDER_MODE: ModeOption = {
  id: 'proxy',
  label: 'Proxy',
  description: 'Connected extension transport',
  color: '#58a6ff',
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
}

export function isBuiltinProvider(providerId: string): providerId is BuiltinProvider {
  return providerId === 'claude'
    || providerId === 'codex'
    || providerId === 'opencode'
    || providerId === 'openclaw'
    || providerId === 'hermes'
}

export function getApproxContextWindowTokens(providerId: string, modelId: string): number {
  const normalizedModel = modelId.toLowerCase()
  const normalizedProvider = providerId.toLowerCase()

  if (normalizedModel.includes('gpt-5.4')) return 258_000
  if (normalizedModel.includes('o3') || normalizedModel.includes('o4')) return 200_000
  if (normalizedProvider === 'claude' || normalizedModel.includes('claude')) return 200_000
  if (normalizedProvider === 'codex') return 258_000
  return 128_000
}

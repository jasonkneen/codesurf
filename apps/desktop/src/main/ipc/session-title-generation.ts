export const GENERATED_TITLE_MODEL = 'claude-haiku-4-5-20251001'
export const GENERATED_TITLE_MAX_CHARS = 64
export const GENERATED_TITLE_MIN_WORDS = 3
export const GENERATED_TITLE_MAX_WORDS = 4
export const GENERATED_TITLE_TRANSCRIPT_BUDGET = 90_000
export const GENERATED_TITLE_HEAD_MESSAGES = 32
export const GENERATED_TITLE_TAIL_MESSAGES = 96

export interface SessionTitlePromptInput {
  currentTitle: string
  provider: string
  model: string
  messageCount: number
  transcript: string
}

export interface SessionTitleGenerationGate<T> {
  isRunning: (key: string) => boolean
  run: (key: string, factory: () => Promise<T> | T) => Promise<T>
}

export interface SessionTitleModelSelectionInput {
  provider?: string | null
  model?: string | null
}

export type SessionTitleModelCandidateSource = 'current-provider' | 'free-fallback' | 'last-resort-claude'

export type SessionTitleModelCandidate =
  | {
      kind: 'openai-compatible'
      provider: 'openai' | 'openrouter'
      model: string
      baseUrl: string
      apiKey: string
      apiKeyEnv: string
      source: SessionTitleModelCandidateSource
    }
  | {
      kind: 'claude-sdk'
      provider: 'claude'
      model: string
      source: SessionTitleModelCandidateSource
    }

export type SessionTitleEnv = Record<string, string | undefined>

export const OPENAI_TITLE_MODEL = 'gpt-5.1-codex-mini'
export const OPENROUTER_FREE_TITLE_MODELS = [
  'deepseek/deepseek-chat-v3-0324:free',
  'google/gemini-2.0-flash-exp:free',
  'meta-llama/llama-3.1-8b-instruct:free',
]

const TITLE_TOKEN_OVERRIDES = new Map<string, string>([
  ['api', 'API'],
  ['cli', 'CLI'],
  ['css', 'CSS'],
  ['html', 'HTML'],
  ['ipc', 'IPC'],
  ['json', 'JSON'],
  ['llm', 'LLM'],
  ['mcp', 'MCP'],
  ['sdk', 'SDK'],
  ['ui', 'UI'],
  ['url', 'URL'],
  ['codex', 'Codex'],
  ['claude', 'Claude'],
  ['openai', 'OpenAI'],
])

function envValue(env: SessionTitleEnv, key: string): string | null {
  const value = env[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function normalizeProviderRef(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase()
}

function stripModelProviderPrefix(model: string): string {
  return model.trim().replace(/^(?:openai|anthropic|google|meta-llama|deepseek)\//i, '')
}

function selectFastOpenAiTitleModel(model: string | null | undefined): string {
  const stripped = stripModelProviderPrefix(String(model ?? '').trim())
  const normalized = stripped.toLowerCase()
  if (normalized.includes('mini') && stripped) return stripped
  if (normalized === 'o4-mini' || normalized === 'o3-mini') return stripped
  return OPENAI_TITLE_MODEL
}

function addUniqueCandidate(candidates: SessionTitleModelCandidate[], candidate: SessionTitleModelCandidate): void {
  const key = candidate.kind === 'openai-compatible'
    ? `${candidate.kind}:${candidate.provider}:${candidate.model}:${candidate.source}`
    : `${candidate.kind}:${candidate.model}:${candidate.source}`
  const exists = candidates.some(existing => {
    const existingKey = existing.kind === 'openai-compatible'
      ? `${existing.kind}:${existing.provider}:${existing.model}:${existing.source}`
      : `${existing.kind}:${existing.model}:${existing.source}`
    return existingKey === key
  })
  if (!exists) candidates.push(candidate)
}

export function resolveSessionTitleModelCandidates(
  input: SessionTitleModelSelectionInput,
  env: SessionTitleEnv = process.env as SessionTitleEnv,
): SessionTitleModelCandidate[] {
  const provider = normalizeProviderRef(input.provider)
  const model = String(input.model ?? '').trim()
  const normalizedModel = model.toLowerCase()
  const candidates: SessionTitleModelCandidate[] = []

  const openAiKey = envValue(env, 'OPENAI_API_KEY')
  const openRouterKey = envValue(env, 'OPENROUTER_API_KEY')

  const isOpenAiProvider = provider === 'openai'
    || provider === 'codex'
    || normalizedModel.startsWith('openai/')
    || /^gpt-|^o\d/.test(normalizedModel)

  if (openAiKey && isOpenAiProvider) {
    addUniqueCandidate(candidates, {
      kind: 'openai-compatible',
      provider: 'openai',
      model: selectFastOpenAiTitleModel(model),
      baseUrl: 'https://api.openai.com/v1',
      apiKey: openAiKey,
      apiKeyEnv: 'OPENAI_API_KEY',
      source: 'current-provider',
    })
  }

  const isOpenRouterProvider = provider === 'openrouter' || normalizedModel.includes(':free')
  if (openRouterKey && isOpenRouterProvider && model) {
    addUniqueCandidate(candidates, {
      kind: 'openai-compatible',
      provider: 'openrouter',
      model,
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: openRouterKey,
      apiKeyEnv: 'OPENROUTER_API_KEY',
      source: 'current-provider',
    })
  }

  if (openRouterKey) {
    for (const freeModel of OPENROUTER_FREE_TITLE_MODELS) {
      addUniqueCandidate(candidates, {
        kind: 'openai-compatible',
        provider: 'openrouter',
        model: freeModel,
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: openRouterKey,
        apiKeyEnv: 'OPENROUTER_API_KEY',
        source: 'free-fallback',
      })
    }
  }

  const isClaudeProvider = provider === 'claude' || normalizedModel.includes('claude') || normalizedModel.startsWith('anthropic/')
  if (isClaudeProvider) {
    addUniqueCandidate(candidates, {
      kind: 'claude-sdk',
      provider: 'claude',
      model: stripModelProviderPrefix(model) || GENERATED_TITLE_MODEL,
      source: provider === 'claude' ? 'current-provider' : 'last-resort-claude',
    })
  }

  return candidates
}

export function describeSessionTitleModelCandidate(candidate: SessionTitleModelCandidate): string {
  if (candidate.kind === 'openai-compatible') {
    const source = candidate.source === 'free-fallback' ? 'free fallback' : 'current provider'
    return `${candidate.provider}/${candidate.model} (${source})`
  }
  const source = candidate.source === 'last-resort-claude' ? 'last-resort Claude' : 'current provider'
  return `claude-sdk/${candidate.model} (${source})`
}

export function redactTitleGenerationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/(?:sk|sk-or|sk-ant|sess)-[A-Za-z0-9_\-]{10,}/g, '[REDACTED]')
}

const FILLER_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'for',
  'from',
  'in',
  'into',
  'is',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'with',
])

const LEADING_FILLER_WORDS = new Set([
  'a',
  'an',
  'about',
  'and',
  'conversation',
  'chat',
  'session',
  'summary',
  'the',
  'this',
  'thread',
  'title',
])

function truncateHard(text: string, hardCap: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= hardCap) return trimmed
  return trimmed.slice(0, hardCap).trimEnd()
}

function isSessionTitleBoilerplateLine(line: string): boolean {
  const normalized = line.trim()
  if (!normalized) return true
  return /^(?:#\s*)?AGENTS\.md instructions for\b/i.test(normalized)
    || /^(?:#\s*)?CLAUDE\.md instructions for\b/i.test(normalized)
    || /^<\/?environment_context>$/i.test(normalized)
    || /^<INSTRUCTIONS>$/i.test(normalized)
    || /^<\/INSTRUCTIONS>$/i.test(normalized)
    || /^---\s*project-doc\s*---$/i.test(normalized)
    || /^#+\s*(?:Non-Negotiable Rules|GSDN Native Mode|Installed GSDN assets|Usage rules|Skills|Files mentioned by the user)\b/i.test(normalized)
    || /^Launching skill:/i.test(normalized)
    || /^Base directory for this skill:/i.test(normalized)
    || /^The `?\.codesurf\/DREAMING\.md`? has been written/i.test(normalized)
}

function firstMeaningfulTitleLine(text: string): string | null {
  const source = text.replace(/\r\n/g, '\n').trim()
  if (!source) return null

  const explicitRequest = source.match(/#+\s*My request for Codex:\s*([\s\S]+)/i)
  if (explicitRequest?.[1]?.trim()) return firstMeaningfulTitleLine(explicitRequest[1])

  let insideInstructions = false
  let insideEnvironmentContext = false
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^<environment_context>$/i.test(line)) {
      insideEnvironmentContext = true
      continue
    }
    if (/^<\/environment_context>$/i.test(line)) {
      insideEnvironmentContext = false
      continue
    }
    if (insideEnvironmentContext) continue

    if (/<INSTRUCTIONS>/i.test(line)) {
      insideInstructions = true
      continue
    }
    if (/<\/INSTRUCTIONS>/i.test(line)) {
      insideInstructions = false
      continue
    }
    if (insideInstructions) continue

    const workspacePrompt = line.match(/^Workspace:\s+.+?\bPrimary path:\s+\S+\s+(.+)$/i)
    if (workspacePrompt?.[1]?.trim()) return workspacePrompt[1].trim()

    if (isSessionTitleBoilerplateLine(line)) continue
    return line
  }

  return null
}

export function cleanSessionTitleCandidate(text: string | null | undefined, hardCap = GENERATED_TITLE_MAX_CHARS): string | null {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null

  let next = (firstMeaningfulTitleLine(trimmed) ?? trimmed)
    .replace(/^```(?:json|JSON)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/\r\n/g, '\n')
    .split(/\r?\n/, 1)[0]
    .trim()

  next = next.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
  next = next.replace(/`([^`]+)`/g, '$1')
  next = next.replace(/^[-*+]\s+/, '')
  next = next.replace(/^\[[ xX]\]\s+/, '')
  next = next.replace(/^\d+\.\s+/, '')
  next = next.replace(/^#+\s+/, '')
  next = next.replace(/\s+/g, ' ').trim()
  next = next.replace(/[.!?。]+$/g, '').trim()

  if (isSessionTitleBoilerplateLine(next)) return null
  if (!next) return null
  return truncateHard(next, hardCap)
}

export function trimTranscriptText(text: string, maxChars = 2_000): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars).trimEnd()}…`
}

export function formatTranscriptMessage(message: Record<string, unknown>, index: number): string | null {
  const role = typeof message.role === 'string' && message.role.trim()
    ? message.role.trim()
    : 'unknown'
  const content = typeof message.content === 'string' ? trimTranscriptText(message.content) : ''
  if (!content) return null
  return `${index + 1}. ${role}: ${content}`
}

export function buildTitleTranscript(messages: Record<string, unknown>[]): string {
  if (messages.length === 0) return ''

  const selected = messages.length <= (GENERATED_TITLE_HEAD_MESSAGES + GENERATED_TITLE_TAIL_MESSAGES)
    ? messages
    : [
        ...messages.slice(0, GENERATED_TITLE_HEAD_MESSAGES),
        ...messages.slice(-GENERATED_TITLE_TAIL_MESSAGES),
      ]

  const chunks: string[] = []
  let used = 0

  for (let index = 0; index < selected.length; index += 1) {
    if (messages.length > selected.length && index === GENERATED_TITLE_HEAD_MESSAGES) {
      const omittedCount = messages.length - selected.length
      const omitted = `... ${omittedCount} earlier middle messages omitted for brevity ...`
      if (used + omitted.length > GENERATED_TITLE_TRANSCRIPT_BUDGET) break
      chunks.push(omitted)
      used += omitted.length + 1
    }

    const rawIndex = messages.length <= selected.length
      ? index
      : (index < GENERATED_TITLE_HEAD_MESSAGES ? index : messages.length - (selected.length - index))
    const formatted = formatTranscriptMessage(selected[index] as Record<string, unknown>, rawIndex)
    if (!formatted) continue
    if (used + formatted.length > GENERATED_TITLE_TRANSCRIPT_BUDGET) break
    chunks.push(formatted)
    used += formatted.length + 1
  }

  return chunks.join('\n')
}

function extractJsonTitle(rawText: string): string | null {
  const trimmed = rawText.trim()
  const withoutFence = trimmed
    .replace(/^```(?:json|JSON)?\s*/i, '')
    .replace(/```$/i, '')
    .trim()

  for (const candidate of [withoutFence, trimmed]) {
    try {
      const parsed = JSON.parse(candidate) as { title?: unknown }
      if (typeof parsed.title === 'string' && parsed.title.trim()) return parsed.title.trim()
    } catch {
      // fall through to regex extraction
    }
  }

  const jsonMatch = withoutFence.match(/"title"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i)
  if (!jsonMatch?.[1]) return null
  try {
    return JSON.parse(`"${jsonMatch[1]}"`)
  } catch {
    return jsonMatch[1]
  }
}

function extractQuotedTitle(rawText: string): string | null {
  const titlePattern = /(?:title|thread title|concise title)\s*(?:is|would be|should be|:)\s*["“']([^"”'\n.]+)["”']/i
  const titleMatch = rawText.match(titlePattern)
  if (titleMatch?.[1]?.trim()) return titleMatch[1].trim()

  const quoted = rawText.match(/["“']([^"”'\n.]{6,80})["”']/)
  return quoted?.[1]?.trim() ?? null
}

function stripVerboseTitlePreamble(value: string): string {
  let next = value.trim()

  next = next
    .replace(/^(?:sure|okay|ok)[,.:\s-]+/i, '')
    .replace(/^(?:here(?:'|’)s|here is)\s+(?:a\s+)?(?:concise\s+)?(?:thread\s+)?title\s*(?:for\s+this\s+thread)?\s*[:—–-]?\s*/i, '')
    .replace(/^(?:i(?:'|’)d|i would)\s+(?:title|call)\s+(?:this\s+)?(?:thread\s+)?[:—–-]?\s*/i, '')
    .replace(/^(?:the\s+)?(?:generated\s+)?(?:thread\s+)?title\s*(?:is|would be|should be)?\s*[:—–-]?\s*/i, '')
    .replace(/^(?:this|the)\s+(?:thread|conversation|chat|session)\s+(?:is\s+)?(?:about|focused\s+on|focuses\s+on|covers|discusses|summarizes)\s+/i, '')
    .replace(/^about\s+/i, '')
    .trim()

  return next
}

function titleCaseToken(token: string): string {
  if (!token) return token
  const override = TITLE_TOKEN_OVERRIDES.get(token.toLowerCase())
  if (override) return override
  if (/[A-Z].*[A-Z]/.test(token) || /\d/.test(token)) return token
  return token
    .split('-')
    .map(part => part ? `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}` : part)
    .join('-')
}

function tokenizeTitle(value: string): string[] {
  const cleaned = stripVerboseTitlePreamble(value)
    .replace(/[\[\]{}()*_`~<>]/g, ' ')
    .replace(/[,:;.!?]+/g, ' ')
    .replace(/[“”"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned) return []

  let tokens = cleaned
    .split(/\s+/)
    .map(token => token.replace(/^[^A-Za-z0-9+#./-]+|[^A-Za-z0-9+#./-]+$/g, ''))
    .filter(Boolean)

  while (tokens.length > GENERATED_TITLE_MIN_WORDS && LEADING_FILLER_WORDS.has(tokens[0].toLowerCase())) {
    tokens = tokens.slice(1)
  }

  if (tokens.length > GENERATED_TITLE_MAX_WORDS) {
    const withoutFiller = tokens.filter(token => !FILLER_WORDS.has(token.toLowerCase()))
    if (withoutFiller.length >= GENERATED_TITLE_MIN_WORDS) tokens = withoutFiller
  }

  return tokens
}

function coerceTitlePhrase(value: string | null | undefined): string | null {
  const cleaned = cleanSessionTitleCandidate(value)
  if (!cleaned) return null

  const tokens = tokenizeTitle(cleaned)
  if (tokens.length === 0) return null

  const selected = tokens.slice(0, GENERATED_TITLE_MAX_WORDS).map(titleCaseToken)
  if (selected.length < GENERATED_TITLE_MIN_WORDS) return null

  const title = truncateHard(selected.join(' '), GENERATED_TITLE_MAX_CHARS)
  return title || null
}

function isOperationalNonTitleLine(value: string): boolean {
  const normalized = value.trim()
  if (!normalized) return false
  return /^(?:reading additional input from stdin|openai codex v|workdir:|model:|provider:|approval:|sandbox:|reasoning(?:\s|:)|session id:|--------|user$|assistant$|system$)/i.test(normalized)
}

function isGenericFallbackTitle(value: string | null | undefined): boolean {
  const comparable = normalizeComparableSessionTitle(value)
  if (!comparable) return true
  if (comparable.endsWith(' session')) return true
  return /^(?:untitled chat thread|untitled thread|untitled chat|new chat|new thread|chat thread|old fallback title|long old thread title)$/.test(comparable)
}

const FALLBACK_TITLE_STOPWORDS = new Set([
  ...Array.from(FILLER_WORDS),
  'about',
  'also',
  'assistant',
  'back',
  'because',
  'can',
  'comes',
  'current',
  'does',
  'done',
  'error',
  'from',
  'have',
  'into',
  'invoking',
  'make',
  'message',
  'messages',
  'method',
  'need',
  'needs',
  'ok',
  'okay',
  'please',
  'remote',
  'remove',
  'return',
  'sure',
  'task',
  'text',
  'thi',
  'use',
  'user',
  'wee',
  'why',
])

const FALLBACK_DOMAIN_ORDER = [
  'bypass',
  'codex',
  'mcp',
  'config',
  'ignore',
  'title',
  'generation',
  'sidebar',
  'race',
  'thread',
  'daemon',
  'dreaming',
  'electron',
  'renderer',
  'preload',
  'provider',
  'model',
]

function normalizeFallbackToken(token: string): string | null {
  const normalized = token.toLowerCase()
    .replace(/^[^a-z0-9+#./-]+|[^a-z0-9+#./-]+$/g, '')
  if (!normalized || normalized.length < 2) return null
  if (/^\d+(?:\.\d+)*$/.test(normalized)) return null
  if (FALLBACK_TITLE_STOPWORDS.has(normalized)) return null
  if (normalized === 'coedx') return 'codex'
  if (normalized === 'configg') return 'config'
  return normalized
}

export function deriveFallbackSessionTitle(transcript: string, fallback: string): string {
  const fallbackTitle = coerceTitlePhrase(fallback)
  if (fallbackTitle && !isGenericFallbackTitle(fallbackTitle)) return fallbackTitle

  const weights = new Map<string, number>()
  for (const rawLine of String(transcript ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || isOperationalNonTitleLine(line)) continue
    const roleMatch = line.match(/^\d+\.\s*(user|assistant|system|tool)\s*:\s*(.*)$/i)
    const role = roleMatch?.[1]?.toLowerCase() ?? ''
    const content = roleMatch?.[2] ?? line
    const baseWeight = role === 'user' ? 4 : role === 'assistant' ? 1 : 2
    const tokens = content.match(/[A-Za-z][A-Za-z0-9+#./-]*/g) ?? []
    for (const token of tokens) {
      const normalized = normalizeFallbackToken(token)
      if (!normalized) continue
      const domainBoost = FALLBACK_DOMAIN_ORDER.includes(normalized) ? 3 : 0
      weights.set(normalized, (weights.get(normalized) ?? 0) + baseWeight + domainBoost)
    }
  }

  const domainTokens = FALLBACK_DOMAIN_ORDER.filter(token => weights.has(token))
  let selected = domainTokens.length >= GENERATED_TITLE_MIN_WORDS
    ? domainTokens.slice(0, GENERATED_TITLE_MAX_WORDS)
    : Array.from(weights.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([token]) => token)
        .slice(0, GENERATED_TITLE_MAX_WORDS)

  if (selected.length < GENERATED_TITLE_MIN_WORDS && domainTokens.length > 0) {
    selected = Array.from(new Set([...selected, ...domainTokens])).slice(0, GENERATED_TITLE_MAX_WORDS)
  }

  const derived = coerceTitlePhrase(selected.map(titleCaseToken).join(' '))
  return derived ?? fallbackTitle ?? 'Untitled Chat Thread'
}

export function sanitizeGeneratedSessionTitle(raw: string, fallback: string): string {
  const rawText = String(raw ?? '').trim()
  const fallbackTitle = coerceTitlePhrase(fallback) ?? 'Untitled Chat Thread'
  if (!rawText) return fallbackTitle

  const candidates = [
    extractJsonTitle(rawText),
    extractQuotedTitle(rawText),
    ...rawText.split(/\r?\n/),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)

  for (const candidate of candidates) {
    const normalized = stripVerboseTitlePreamble(candidate)
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim()

    if (!normalized) continue
    if (isOperationalNonTitleLine(normalized)) continue
    if (/^(?:i('|’)ll|i will|let me|i can|based on)\b/i.test(normalized)) continue
    if (/\b(?:read|reading|transcript|understand|appropriate title)\b/i.test(normalized)) continue

    const title = coerceTitlePhrase(normalized)
    if (title) return title
  }

  return fallbackTitle
}

export function buildSessionTitlePrompt(input: SessionTitlePromptInput): string {
  return [
    'Task: Generate a title for this thread.',
    'This is title generation only. Do not answer the transcript. Do not summarize in a sentence.',
    'Return JSON only: {"title":"Three Four Word Title"}.',
    'The title value must be 3 to 4 words.',
    'Use the concrete task, bug, feature, or decision that best represents the whole thread.',
    'No preamble. No markdown. No quotes inside the title. No trailing punctuation.',
    'Avoid generic words unless they are part of the actual topic.',
    `Keep the title under ${GENERATED_TITLE_MAX_CHARS} characters.`,
    '',
    `Current title: ${input.currentTitle}`,
    `Provider: ${input.provider || 'unknown'}`,
    `Model: ${input.model || 'unknown'}`,
    `Message count: ${input.messageCount}`,
    '',
    'Transcript:',
    input.transcript,
  ].join('\n')
}

export function normalizeComparableSessionTitle(value: string | null | undefined): string {
  return (cleanSessionTitleCandidate(value) ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function hasSessionTitleChangedDuringGeneration(
  initialTitle: string | null | undefined,
  currentTitle: string | null | undefined,
): boolean {
  const initial = normalizeComparableSessionTitle(initialTitle)
  const current = normalizeComparableSessionTitle(currentTitle)
  if (!current) return false
  if (!initial) return true
  return initial !== current
}

export function createSessionTitleGenerationGate<T>(): SessionTitleGenerationGate<T> {
  const inFlight = new Map<string, Promise<T>>()

  return {
    isRunning: (key: string) => inFlight.has(key),
    run: (key: string, factory: () => Promise<T> | T) => {
      const existing = inFlight.get(key)
      if (existing) return existing

      const promise = Promise.resolve()
        .then(factory)
        .finally(() => {
          if (inFlight.get(key) === promise) inFlight.delete(key)
        })

      inFlight.set(key, promise)
      return promise
    },
  }
}

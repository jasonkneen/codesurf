export type AgentCliOutputFormat = 'text' | 'json' | 'stream-json'
export type CodeSurfApprovalMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
export type GeminiApprovalMode = 'default' | 'auto_edit' | 'yolo' | 'plan'
export type ClineTaskMode = 'plan' | 'act'
export type AmpMode = 'deep' | 'free' | 'large' | 'rush' | 'smart'

export interface ParsedAgentCliOutput {
  text: string
  sessionId: string | null
  raw?: unknown[]
}

function pushFlag(args: string[], flag: string, value: string | number | null | undefined): void {
  if (value === null || value === undefined) return
  const str = String(value)
  if (!str) return
  args.push(flag, str)
}

const HERMES_MODEL_PROVIDER_PREFIXES: Record<string, string> = {
  'anthropic': 'anthropic',
  'arcee': 'arcee',
  'arcee-ai': 'arcee',
  'copilot': 'copilot',
  'copilot-acp': 'copilot-acp',
  'gemini': 'gemini',
  'google': 'gemini',
  'huggingface': 'huggingface',
  'kimi-coding': 'kimi-coding',
  'kimi-coding-cn': 'kimi-coding-cn',
  'kilocode': 'kilocode',
  'minimax': 'minimax',
  'minimax-cn': 'minimax-cn',
  'nous': 'nous',
  'nvidia': 'nvidia',
  'ollama-cloud': 'ollama-cloud',
  'openai': 'openai',
  'openai-codex': 'openai-codex',
  'openrouter': 'openrouter',
  'stepfun': 'stepfun',
  'x-ai': 'xai',
  'xai': 'xai',
  'xiaomi': 'xiaomi',
  'z-ai': 'zai',
  'zai': 'zai',
}

export function resolveHermesModelSelection(model: string | null | undefined, provider?: string | null): {
  model: string | null
  provider: string | null
} {
  const rawModel = String(model ?? '').trim()
  const explicitProvider = String(provider ?? '').trim()
  if (!rawModel) return { model: null, provider: explicitProvider || null }
  if (explicitProvider) return { model: rawModel, provider: explicitProvider }

  const slashIndex = rawModel.indexOf('/')
  if (slashIndex <= 0) return { model: rawModel, provider: null }

  const prefix = rawModel.slice(0, slashIndex).trim().toLowerCase()
  const remainder = rawModel.slice(slashIndex + 1).trim()
  const inferredProvider = HERMES_MODEL_PROVIDER_PREFIXES[prefix]
  if (!inferredProvider || !remainder) return { model: rawModel, provider: null }

  return { model: remainder, provider: inferredProvider }
}

function parseJsonLines(stdout: string): unknown[] {
  const parsed: unknown[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      parsed.push(JSON.parse(trimmed))
    } catch {
      // Ignore non-JSON status/progress lines. Callers still have stdout for fallback text.
    }
  }
  return parsed
}

function extractSessionId(value: any): string | null {
  if (!value || typeof value !== 'object') return null
  const candidates = [
    value.sessionId,
    value.session_id,
    value.sessionID,
    value.session_id,
    value.id,
    value.result?.sessionId,
    value.result?.session_id,
    value.result?.sessionID,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return null
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      return typeof record.text === 'string'
        ? record.text
        : typeof record.content === 'string'
          ? record.content
          : ''
    })
    .filter(Boolean)
    .join('')
}

export function buildHermesChatArgs(request: {
  prompt: string
  model?: string | null
  provider?: string | null
  toolsets?: string[] | string | null
  resumeSessionId?: string | null
  ignoreRules?: boolean
  ignoreUserConfig?: boolean
  bypassPermissions?: boolean
  /**
   * When true AND the installed `hermes chat` binary advertises
   * `--stream-json`, request NDJSON events. Hermes Agent (Nous) 0.20.x
   * has no such flag — argparse rejects unknown arguments — so the
   * default is `--quiet` (final response + session info). Probe with
   * `hermesChatHelpSupportsStreamJson` before setting this.
   */
  streamJson?: boolean
}): string[] {
  const outputFlag = request.streamJson === true ? '--stream-json' : '--quiet'
  const args = ['chat', '--query', request.prompt, outputFlag, '--source', 'tool']
  const selection = resolveHermesModelSelection(request.model, request.provider)
  pushFlag(args, '--model', selection.model)
  pushFlag(args, '--provider', selection.provider)

  const toolsets = Array.isArray(request.toolsets)
    ? request.toolsets.filter(Boolean).join(',')
    : request.toolsets
  pushFlag(args, '--toolsets', toolsets)
  pushFlag(args, '--resume', request.resumeSessionId)

  if (request.ignoreRules) args.push('--ignore-rules')
  if (request.ignoreUserConfig) args.push('--ignore-user-config')
  if (request.bypassPermissions) args.push('--yolo')
  return args
}

/** True when `hermes chat --help` documents `--stream-json`. */
export function hermesChatHelpSupportsStreamJson(helpText: string): boolean {
  const text = String(helpText ?? '')
  if (/unrecognized arguments/i.test(text)) return false
  return /(?:^|\s)--stream-json\b/.test(text)
}

export function parseHermesOutput(stdout: string): ParsedAgentCliOutput {
  let sessionId: string | null = null
  const visibleLines: string[] = []

  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:session_id|session)\s*:\s*(\S+)\s*$/i)
    if (match) {
      sessionId ??= match[1]
      continue
    }
    visibleLines.push(line)
  }

  return {
    text: visibleLines.join('\n').trim(),
    sessionId,
  }
}

/**
 * Parse Hermes NDJSON event stream produced by `hermes chat --stream-json`.
 *
 * Each non-blank stdout line is a JSON event with a `type` field. The events
 * we care about for batch consumption:
 *  - `{type:'text', text}`           → assistant text delta (concatenate)
 *  - `{type:'session', sessionId}`   → session id (latest wins)
 *  - `{type:'error', error}`         → set on parsed.raw; caller decides
 *
 * Tool events (`tool_start`/`tool_input`/`tool_summary`/`thinking`) are kept
 * in `raw` for downstream consumers but do not contribute to `text`.
 *
 * Non-JSON lines (e.g. stray prints from an older binary) are ignored.
 */
export function parseHermesStreamJsonOutput(stdout: string): ParsedAgentCliOutput {
  const raw: unknown[] = []
  const textParts: string[] = []
  let sessionId: string | null = null

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let evt: any
    try {
      evt = JSON.parse(trimmed)
    } catch {
      // Older Hermes binaries (no --stream-json support) fall back to plain
      // text. Treat unparseable lines as raw text so we don't lose content
      // when a misconfigured environment routes through this parser.
      textParts.push(line)
      continue
    }
    raw.push(evt)
    if (!evt || typeof evt !== 'object') continue
    if (typeof evt.type !== 'string') continue
    switch (evt.type) {
      case 'text':
        if (typeof evt.text === 'string') textParts.push(evt.text)
        break
      case 'session':
        if (typeof evt.sessionId === 'string' && evt.sessionId.trim()) {
          sessionId = evt.sessionId.trim()
        }
        break
      default:
        break
    }
  }

  return {
    text: textParts.join('').trim(),
    sessionId,
    raw,
  }
}

export function buildOpenClawAgentArgs(request: {
  prompt: string
  agentId?: string | null
  sessionId?: string | null
  thinking?: string | null
  timeoutSeconds?: number | null
  local?: boolean
}): string[] {
  const args = ['agent', '--json']
  if (request.sessionId) {
    args.push('--session-id', request.sessionId)
  } else {
    args.push('--agent', request.agentId || 'main')
  }
  args.push('--message', request.prompt)
  pushFlag(args, '--thinking', normalizeOpenClawThinking(request.thinking))
  pushFlag(args, '--timeout', request.timeoutSeconds)
  if (request.local) args.push('--local')
  return args
}

export function normalizeOpenClawThinking(thinking?: string | null): string | null {
  const value = typeof thinking === 'string' ? thinking.trim() : ''
  if (!value) return null

  const thinkingMap: Record<string, string> = {
    none: 'off',
    low: 'minimal',
    medium: 'medium',
    high: 'high',
    max: 'xhigh',
    adaptive: 'medium',
    off: 'off',
    minimal: 'minimal',
    xhigh: 'xhigh',
  }

  return thinkingMap[value] ?? value
}

function extractOpenClawTextPayload(payload: any): string {
  if (!payload || typeof payload !== 'object') return ''
  if (typeof payload.text === 'string') return payload.text
  if (typeof payload.content === 'string') return payload.content
  if (typeof payload.message === 'string') return payload.message
  if (typeof payload.summary === 'string') return payload.summary
  if (Array.isArray(payload.parts)) {
    return payload.parts
      .map((part: { text?: string }) => typeof part?.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('')
  }
  return ''
}

export function parseOpenClawOutput(stdout: string): ParsedAgentCliOutput {
  try {
    const parsed = JSON.parse(stdout)
    const payloads = Array.isArray(parsed?.payloads)
      ? parsed.payloads
      : Array.isArray(parsed?.result?.payloads)
        ? parsed.result.payloads
        : []
    const text = payloads
      .map((payload: any) => extractOpenClawTextPayload(payload))
      .filter(Boolean)
      .join('\n\n')
      || parsed?.summary
      || parsed?.result?.summary
      || parsed?.message
      || ''
    return {
      text: String(text).trim(),
      sessionId: extractSessionId(parsed)
        ?? extractSessionId(parsed?.meta)
        ?? extractSessionId(parsed?.result?.meta),
      raw: [parsed],
    }
  } catch {
    return { text: stdout.trim(), sessionId: null }
  }
}

export type BoundedOpenClawOutput =
  | { ok: true, output: ParsedAgentCliOutput }
  | { ok: false, error: string }

/**
 * OpenClaw returns one JSON envelope after the process exits. A retained tail
 * is not a valid envelope, so it must never be surfaced as assistant text.
 */
export function parseBoundedOpenClawOutput(
  stdout: string,
  truncated: boolean,
): BoundedOpenClawOutput {
  if (truncated) {
    return {
      ok: false,
      error: 'OpenClaw response exceeded the output limit and was discarded',
    }
  }
  return { ok: true, output: parseOpenClawOutput(stdout) }
}

export function buildOpenCodeRunArgs(request: {
  prompt: string
  model?: string | null
  agent?: string | null
  sessionId?: string | null
  continueSession?: boolean
  cwd?: string | null
  attachUrl?: string | null
  variant?: string | null
  thinking?: boolean
  bypassPermissions?: boolean
}): string[] {
  const args = ['run', '--format', 'json']
  pushFlag(args, '--model', request.model)
  pushFlag(args, '--agent', request.agent)
  pushFlag(args, '--session', request.sessionId)
  if (request.continueSession) args.push('--continue')
  pushFlag(args, '--dir', request.cwd)
  pushFlag(args, '--attach', request.attachUrl)
  pushFlag(args, '--variant', request.variant)
  if (request.thinking) args.push('--thinking')
  if (request.bypassPermissions) args.push('--dangerously-skip-permissions')
  args.push(request.prompt)
  return args
}

export function parseOpenCodeRunOutput(stdout: string): ParsedAgentCliOutput {
  const raw = parseJsonLines(stdout)
  if (raw.length === 0) return { text: stdout.trim(), sessionId: null }

  const textParts: string[] = []
  let sessionId: string | null = null

  for (const event of raw) {
    const value = event as any
    sessionId ??= extractSessionId(value)
    if (!value || typeof value !== 'object') continue

    if (typeof value.result === 'string') textParts.push(value.result)
    if (typeof value.text === 'string' && (value.role === 'assistant' || value.type === 'assistant')) textParts.push(value.text)
    if (typeof value.message === 'string' && (value.role === 'assistant' || value.type === 'assistant')) textParts.push(value.message)
    if (value.type === 'message' && value.role === 'assistant') {
      textParts.push(extractContentText(value.content))
    } else if (value.role === 'assistant') {
      textParts.push(extractContentText(value.content))
    }
    if (value.type === 'assistant') textParts.push(extractContentText(value.message?.content ?? value.content))
  }

  return {
    text: textParts.filter(Boolean).join('').trim(),
    sessionId,
    raw,
  }
}

export function buildCursorAgentPrintArgs(request: {
  prompt: string
  cwd?: string | null
  model?: string | null
  resumeChatId?: string | null
  continuePrevious?: boolean
  mode?: 'default' | 'plan' | 'ask' | string | null
  streamPartialOutput?: boolean
  trustWorkspace?: boolean
  bypassPermissions?: boolean
}): { command: 'cursor-agent'; args: string[] } {
  const args = ['--print', '--output-format', 'stream-json']
  if (request.streamPartialOutput) args.push('--stream-partial-output')
  pushFlag(args, '--workspace', request.cwd)
  pushFlag(args, '--model', request.model)
  pushFlag(args, '--resume', request.resumeChatId)
  if (request.continuePrevious) args.push('--continue')
  pushFlag(args, '--mode', request.mode)
  if (request.trustWorkspace) args.push('--trust')
  if (request.bypassPermissions) args.push('--force')
  args.push(request.prompt)
  return { command: 'cursor-agent', args }
}

export function buildGeminiPromptArgs(request: {
  prompt: string
  model?: string | null
  outputFormat?: AgentCliOutputFormat
  resumeSessionId?: string | null
  approvalMode?: GeminiApprovalMode | null
  sandbox?: boolean
  includeDirectories?: string[]
  yolo?: boolean
  rawOutput?: boolean
}): string[] {
  const args = ['--prompt', request.prompt]
  pushFlag(args, '--output-format', request.outputFormat ?? 'stream-json')
  pushFlag(args, '--model', request.model)
  pushFlag(args, '--resume', request.resumeSessionId)
  pushFlag(args, '--approval-mode', request.approvalMode)
  if (request.sandbox) args.push('--sandbox')
  for (const dir of request.includeDirectories ?? []) pushFlag(args, '--include-directories', dir)
  if (request.yolo) args.push('--yolo')
  if (request.rawOutput) args.push('--raw-output', '--accept-raw-output-risk')
  return args
}

export function buildClineTaskArgs(request: {
  prompt: string
  cwd?: string | null
  model?: string | null
  mode?: ClineTaskMode | null
  taskId?: string | null
  continueLatest?: boolean
  timeoutSeconds?: number | null
  json?: boolean
  bypassPermissions?: boolean
}): string[] {
  const args = ['task']
  if (request.json !== false) args.push('--json')
  pushFlag(args, '--cwd', request.cwd)
  pushFlag(args, '--model', request.model)
  if (request.mode === 'plan') args.push('--plan')
  if (request.mode === 'act') args.push('--act')
  pushFlag(args, '--taskId', request.taskId)
  if (request.continueLatest) args.push('--continue')
  pushFlag(args, '--timeout', request.timeoutSeconds)
  if (request.bypassPermissions) args.push('--yolo')
  args.push(request.prompt)
  return args
}

export function buildAmpExecuteArgs(request: {
  prompt: string
  mode?: AmpMode | null
  streamJson?: boolean
  useIdeContext?: boolean
  bypassPermissions?: boolean
  mcpConfig?: string | null
  labels?: string[]
}): string[] {
  const args: string[] = []
  args.push(request.useIdeContext ? '--ide' : '--no-ide')
  pushFlag(args, '--mode', request.mode)
  args.push('--execute', request.prompt)
  if (request.streamJson !== false) args.push('--stream-json')
  if (request.bypassPermissions) args.push('--dangerously-allow-all')
  pushFlag(args, '--mcp-config', request.mcpConfig)
  for (const label of request.labels ?? []) pushFlag(args, '--label', label)
  return args
}

export function buildAmpContinueArgs(request: {
  threadIdOrUrl?: string | null
  last?: boolean
  mode?: AmpMode | null
  useIdeContext?: boolean
}): string[] {
  const args = ['threads', 'continue']
  if (request.threadIdOrUrl) args.push(request.threadIdOrUrl)
  if (request.last) args.push('--last')
  args.push(request.useIdeContext ? '--ide' : '--no-ide')
  pushFlag(args, '--mode', request.mode)
  return args
}

export function buildKiloRunArgs(request: { prompt: string }): string[] {
  return ['run', request.prompt]
}

export function sanitizeAgentCliDiagnostic(message: string): string {
  const secretName = String.raw`[A-Z0-9_./-]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_./-]*`
  const quotedOrBareValue = String.raw`(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)`
  return message
    .replace(new RegExp(`\\b(${secretName})\\s*=\\s*${quotedOrBareValue}`, 'gi'), '$1=[REDACTED]')
    .replace(/\b(authorization\s*:\s*(?:bearer|token)\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gi, '$1[REDACTED]')
    .replace(/\b(api\s*key|api[_-]?key|token|secret|password)\s*:\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gi, '$1: [REDACTED]')
}

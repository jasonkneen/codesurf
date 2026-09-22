export type ElectrobunStreamEvent =
  | { type: 'session', sessionId: string }
  | { type: 'prompt_accepted' }
  | { type: 'text', text: string }
  | { type: 'error', error: string }
  | { type: 'tool_start', toolId: string, toolName?: string }
  | { type: 'tool_summary', toolId?: string, toolName?: string, commandEntries?: Array<Record<string, unknown>> }

function sessionEvent(value: unknown): ElectrobunStreamEvent[] {
  return typeof value === 'string' && value.trim()
    ? [{ type: 'session', sessionId: value.trim() }]
    : []
}

function extractSessionId(value: any): string | null {
  if (!value || typeof value !== 'object') return null
  const candidates = [
    value.sessionId,
    value.session_id,
    value.sessionID,
    value.result?.sessionId,
    value.result?.session_id,
    value.result?.sessionID,
    value.meta?.sessionId,
    value.meta?.session_id,
    value.result?.meta?.sessionId,
    value.result?.meta?.session_id,
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

function extractOpenClawTextPayload(payload: any): string {
  if (!payload || typeof payload !== 'object') return ''
  if (typeof payload.text === 'string') return payload.text
  if (typeof payload.content === 'string') return payload.content
  if (typeof payload.message === 'string') return payload.message
  if (typeof payload.summary === 'string') return payload.summary
  if (Array.isArray(payload.parts)) {
    return payload.parts
      .map((part: any) => typeof part?.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('')
  }
  return ''
}

export interface ElectrobunClaudeStreamParser {
  parseLine: (line: string) => ElectrobunStreamEvent[]
}

function claudeResultError(packet: any): string | null {
  const isError = packet?.is_error === true
    || (typeof packet?.subtype === 'string' && packet.subtype.startsWith('error'))
  if (!isError) return null
  const errors = Array.isArray(packet?.errors)
    ? packet.errors.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
  if (errors.length > 0) return errors.join('\n')
  if (typeof packet?.error === 'string' && packet.error.trim()) return packet.error.trim()
  if (typeof packet?.message === 'string' && packet.message.trim()) return packet.message.trim()
  if (typeof packet?.result === 'string' && packet.result.trim()) return packet.result.trim()
  return 'Claude CLI reported an unsuccessful result.'
}

export function createClaudeStreamParser(): ElectrobunClaudeStreamParser {
  let sawAssistantText = false
  let sealed = false

  return {
    parseLine(line: string): ElectrobunStreamEvent[] {
      if (sealed) return []
      const trimmed = line.trim()
      if (!trimmed) return []

      let packet: any
      try {
        packet = JSON.parse(trimmed)
      } catch {
        sawAssistantText = true
        return [{ type: 'text', text: `${line}\n` }]
      }

      const events: ElectrobunStreamEvent[] = []
      events.push(...sessionEvent(packet?.session_id))

      if (packet?.type === 'stream_event') {
        const event = packet.event
        if (event?.type === 'content_block_delta') {
          const delta = event.delta
          if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
            sawAssistantText = true
            events.push({ type: 'text', text: delta.text })
          }
          // Intentionally drop thinking_delta/signature_delta so hidden reasoning and signatures never render in ChatTile.
        }
        if (event?.type === 'message_delta' && typeof event.delta?.stop_reason === 'string') {
          // Nothing to render; close is handled by process exit.
        }
        return events
      }

      if (packet?.type === 'assistant') {
        // Claude emits final assistant snapshots after streaming deltas. Avoid duplicating streamed text.
        return events
      }

      if (packet?.type === 'result') {
        const error = claudeResultError(packet)
        if (error) {
          events.push({ type: 'error', error })
          sealed = true
          return events
        }
        if (!sawAssistantText && typeof packet.result === 'string' && packet.result) {
          sawAssistantText = true
          events.push({ type: 'text', text: packet.result })
        } else if (!sawAssistantText) {
          events.push({
            type: 'error',
            error: 'Claude finished without assistant output. Please resend the message.',
          })
        }
        sealed = true
        return events
      }

      if (packet?.type === 'error') {
        const message = typeof packet.error === 'string'
          ? packet.error
          : typeof packet.message === 'string'
            ? packet.message
            : 'Claude CLI reported an error.'
        events.push({ type: 'error', error: message })
        sealed = true
      }

      return events
    },
  }
}

export function parseClaudeStreamJsonLine(line: string): ElectrobunStreamEvent[] {
  return createClaudeStreamParser().parseLine(line)
}

export function parseCodexJsonLine(line: string): ElectrobunStreamEvent[] {
  return createCodexStreamParser().parseLine(line)
}

export const MAX_ELECTROBUN_CODEX_COMMAND_BYTES = 64 * 1024
export const MAX_ELECTROBUN_CODEX_COMMAND_OUTPUT_BYTES = 64 * 1024

export interface ElectrobunCodexStreamParser {
  parseLine: (line: string) => ElectrobunStreamEvent[]
}

function boundedUtf8(value: unknown, maxBytes: number): string {
  const text = String(value ?? '')
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
}

function codexErrorMessage(event: any): string {
  if (typeof event?.error === 'string' && event.error.trim()) return event.error.trim()
  if (typeof event?.error?.message === 'string' && event.error.message.trim()) return event.error.message.trim()
  if (typeof event?.message === 'string' && event.message.trim()) return event.message.trim()
  return 'Codex CLI reported an error.'
}

export function createCodexStreamParser(): ElectrobunCodexStreamParser {
  let sealed = false
  let commandSequence = 0

  return {
    parseLine(line: string): ElectrobunStreamEvent[] {
      if (sealed) return []
      const trimmed = line.trim()
      if (!trimmed) return []

      let event: any
      try {
        event = JSON.parse(trimmed)
      } catch {
        return [{ type: 'text', text: `${line}\n` }]
      }

      const events: ElectrobunStreamEvent[] = []
      if (event.type === 'turn.failed' || event.type === 'error') {
        sealed = true
        return [{ type: 'error', error: codexErrorMessage(event) }]
      }
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        events.push({ type: 'session', sessionId: event.thread_id })
      }
      if (event.type === 'turn.completed') {
        events.push({ type: 'prompt_accepted' })
      }

      const item = event.item && typeof event.item === 'object' ? event.item : null
      if (event.type === 'item.completed' && item) {
        if (item.type === 'agent_message' && typeof item.text === 'string' && item.text) {
          events.push({ type: 'text', text: item.text })
        } else if (item.type === 'command_execution' && typeof item.command === 'string') {
          commandSequence += 1
          const toolId = `codex-command-${commandSequence}`
          const command = boundedUtf8(item.command, MAX_ELECTROBUN_CODEX_COMMAND_BYTES)
          const output = boundedUtf8(item.aggregated_output, MAX_ELECTROBUN_CODEX_COMMAND_OUTPUT_BYTES)
          events.push(
            { type: 'tool_start', toolId, toolName: 'Command' },
            {
              type: 'tool_summary',
              toolId,
              toolName: 'Command',
              commandEntries: [{ label: command, command, output, kind: 'command' }],
            },
          )
        } else if (item.type === 'file_change' && Array.isArray(item.changes)) {
          events.push({
            type: 'tool_summary',
            toolId: 'codex-file-changes',
            toolName: `Edited ${item.changes.length} file${item.changes.length === 1 ? '' : 's'}`,
          })
        }
      } else if (typeof event.delta === 'string') {
        events.push({ type: 'text', text: event.delta })
      } else if (typeof event.text === 'string' && event.text) {
        events.push({ type: 'text', text: event.text })
      }

      return events
    },
  }
}

export function parseOpenCodeJsonLine(line: string): ElectrobunStreamEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []

  let value: any
  try {
    value = JSON.parse(trimmed)
  } catch {
    return [{ type: 'text', text: `${line}\n` }]
  }

  const events: ElectrobunStreamEvent[] = []
  events.push(...sessionEvent(extractSessionId(value)))
  if (!value || typeof value !== 'object') return events

  if (typeof value.result === 'string' && value.result) {
    events.push({ type: 'text', text: value.result })
  }
  if (typeof value.text === 'string' && value.text && (value.role === 'assistant' || value.type === 'assistant')) {
    events.push({ type: 'text', text: value.text })
  }
  if (typeof value.message === 'string' && value.message && (value.role === 'assistant' || value.type === 'assistant')) {
    events.push({ type: 'text', text: value.message })
  }
  if (value.type === 'message' && value.role === 'assistant') {
    const text = extractContentText(value.content)
    if (text) events.push({ type: 'text', text })
  } else if (value.role === 'assistant') {
    const text = extractContentText(value.content)
    if (text) events.push({ type: 'text', text })
  }
  if (value.type === 'assistant') {
    const text = extractContentText(value.message?.content ?? value.content)
    if (text) events.push({ type: 'text', text })
  }
  if (value.type === 'error') {
    const error = typeof value.error === 'string'
      ? value.error
      : typeof value.message === 'string'
        ? value.message
        : 'OpenCode CLI reported an error.'
    events.push({ type: 'error', error })
  }

  return events
}

export function parseOpenClawOutput(stdout: string): ElectrobunStreamEvent[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []

  try {
    const parsed = JSON.parse(trimmed)
    const payloads = Array.isArray(parsed?.payloads)
      ? parsed.payloads
      : Array.isArray(parsed?.result?.payloads)
        ? parsed.result.payloads
        : []
    const resultText = payloads
      .map((payload: any) => extractOpenClawTextPayload(payload))
      .filter(Boolean)
      .join('\n\n')
      || parsed?.summary
      || parsed?.result?.summary
      || parsed?.message
      || parsed?.result
      || ''

    const events: ElectrobunStreamEvent[] = []
    events.push(...sessionEvent(extractSessionId(parsed)))
    if (typeof resultText === 'string' && resultText.trim()) events.push({ type: 'text', text: resultText.trim() })
    return events
  } catch {
    return [{ type: 'text', text: trimmed }]
  }
}

/**
 * Agent streaming parsers.
 * Each agent emits SSE or newline-delimited JSON. We parse their native formats
 * and normalise to { type, text, done, error } events that the renderer consumes.
 */

import { IncomingMessage } from 'http'
import { broadcastToRenderer } from './utils/broadcast'
import { BoundedLineDecoder } from './chat/bounded-output.ts'

export interface StreamEvent {
  cardId: string
  type: 'text' | 'thinking' | 'tool_use' | 'done' | 'error'
  text?: string
  toolName?: string
  toolInput?: unknown
  error?: string
}

export type StreamEventEmitter = (event: StreamEvent) => void

function sendStream(_cardId: string, event: StreamEvent): void {
  broadcastToRenderer('agent:stream', event)
}

// ─── Claude streaming (SSE, Anthropic format) ────────────────────────────────

export function parseClaudeStream(
  cardId: string,
  res: IncomingMessage,
  emit: StreamEventEmitter = event => sendStream(cardId, event),
): void {
  const decoder = new BoundedLineDecoder()
  let doneSent = false
  const sendDone = (): void => {
    if (doneSent) return
    doneSent = true
    emit({ cardId, type: 'done' })
  }

  res.on('data', (chunk: Buffer) => {
    for (const line of decoder.push(chunk.toString())) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') {
        sendDone()
        continue
      }
      try {
        const evt = JSON.parse(data)
        if (evt.type === 'content_block_delta') {
          const delta = evt.delta
          if (delta?.type === 'text_delta') {
            emit({ cardId, type: 'text', text: delta.text })
          } else if (delta?.type === 'thinking_delta') {
            emit({ cardId, type: 'thinking', text: delta.thinking })
          }
        } else if (evt.type === 'content_block_start') {
          if (evt.content_block?.type === 'tool_use') {
            emit({ cardId, type: 'tool_use', toolName: evt.content_block.name })
          }
        } else if (evt.type === 'message_stop') {
          sendDone()
        } else if (evt.type === 'error') {
          emit({ cardId, type: 'error', error: evt.error?.message ?? 'Unknown error' })
        }
      } catch { /* non-JSON line */ }
    }
  })

  res.on('error', err => emit({ cardId, type: 'error', error: err.message }))
  res.on('end', () => sendDone())
}

// ─── Codex streaming (SSE, OpenAI format) ────────────────────────────────────

export function parseCodexStream(cardId: string, res: IncomingMessage): void {
  const decoder = new BoundedLineDecoder()
  let doneSent = false
  const sendDone = (): void => {
    if (doneSent) return
    doneSent = true
    sendStream(cardId, { cardId, type: 'done' })
  }

  res.on('data', (chunk: Buffer) => {
    for (const line of decoder.push(chunk.toString())) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') {
        sendDone()
        continue
      }
      try {
        const evt = JSON.parse(data)
        // OpenAI chat completions streaming format
        const delta = evt.choices?.[0]?.delta
        if (delta?.content) {
          sendStream(cardId, { cardId, type: 'text', text: delta.content })
        }
        // Tool calls
        if (delta?.tool_calls?.[0]?.function?.name) {
          sendStream(cardId, { cardId, type: 'tool_use', toolName: delta.tool_calls[0].function.name })
        }
        if (evt.choices?.[0]?.finish_reason === 'stop') {
          sendDone()
        }
      } catch { /* non-JSON */ }
    }
  })

  res.on('error', err => sendStream(cardId, { cardId, type: 'error', error: err.message }))
  res.on('end', () => sendDone())
}

// ─── Pi streaming (newline-delimited JSON) ───────────────────────────────────

export function parsePiStream(cardId: string, res: IncomingMessage): void {
  const decoder = new BoundedLineDecoder()
  let doneSent = false
  const sendDone = (): void => {
    if (doneSent) return
    doneSent = true
    sendStream(cardId, { cardId, type: 'done' })
  }

  res.on('data', (chunk: Buffer) => {
    for (const line of decoder.push(chunk.toString())) {
      if (!line.trim()) continue
      try {
        const evt = JSON.parse(line)
        // Pi emits { type: 'text', content: '...' } or { type: 'done' }
        if (evt.type === 'text' || evt.type === 'content') {
          sendStream(cardId, { cardId, type: 'text', text: evt.content ?? evt.text ?? '' })
        } else if (evt.type === 'tool_call' || evt.type === 'tool_use') {
          sendStream(cardId, { cardId, type: 'tool_use', toolName: evt.name ?? evt.tool, toolInput: evt.input ?? evt.arguments })
        } else if (evt.type === 'done' || evt.type === 'end') {
          sendDone()
        } else if (evt.type === 'error') {
          sendStream(cardId, { cardId, type: 'error', error: evt.message ?? evt.error })
        }
      } catch { /* non-JSON */ }
    }
  })

  res.on('error', err => sendStream(cardId, { cardId, type: 'error', error: err.message }))
  res.on('end', () => sendDone())
}

// ─── Generic SSE fallback (for unknown agents) ───────────────────────────────

export function parseGenericStream(cardId: string, res: IncomingMessage): void {
  res.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    sendStream(cardId, { cardId, type: 'text', text })
  })
  res.on('error', err => sendStream(cardId, { cardId, type: 'error', error: err.message }))
  res.on('end', () => sendStream(cardId, { cardId, type: 'done' }))
}

export function getStreamParser(agentId: string): typeof parseClaudeStream {
  switch (agentId) {
    case 'claude': return parseClaudeStream
    case 'codex':  return parseCodexStream
    case 'pi':     return parsePiStream
    default:       return parseGenericStream
  }
}

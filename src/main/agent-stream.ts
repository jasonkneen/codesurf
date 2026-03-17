/**
 * Agent streaming parsers.
 * Each agent emits SSE or newline-delimited JSON. We parse their native formats
 * and normalise to { type, text, done, error } events that the renderer consumes.
 */

import { IncomingMessage } from 'http'
import { BrowserWindow } from 'electron'

export interface StreamEvent {
  cardId: string
  type: 'text' | 'thinking' | 'tool_use' | 'done' | 'error'
  text?: string
  toolName?: string
  toolInput?: unknown
  error?: string
}

function sendStream(cardId: string, event: StreamEvent): void {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('agent:stream', event)
    }
  })
}

// ─── Claude streaming (SSE, Anthropic format) ────────────────────────────────

export function parseClaudeStream(cardId: string, res: IncomingMessage): void {
  let buffer = ''

  res.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') {
        sendStream(cardId, { cardId, type: 'done' })
        continue
      }
      try {
        const evt = JSON.parse(data)
        if (evt.type === 'content_block_delta') {
          const delta = evt.delta
          if (delta?.type === 'text_delta') {
            sendStream(cardId, { cardId, type: 'text', text: delta.text })
          } else if (delta?.type === 'thinking_delta') {
            sendStream(cardId, { cardId, type: 'thinking', text: delta.thinking })
          }
        } else if (evt.type === 'content_block_start') {
          if (evt.content_block?.type === 'tool_use') {
            sendStream(cardId, { cardId, type: 'tool_use', toolName: evt.content_block.name })
          }
        } else if (evt.type === 'message_stop') {
          sendStream(cardId, { cardId, type: 'done' })
        } else if (evt.type === 'error') {
          sendStream(cardId, { cardId, type: 'error', error: evt.error?.message ?? 'Unknown error' })
        }
      } catch { /* non-JSON line */ }
    }
  })

  res.on('error', err => sendStream(cardId, { cardId, type: 'error', error: err.message }))
  res.on('end', () => sendStream(cardId, { cardId, type: 'done' }))
}

// ─── Codex streaming (SSE, OpenAI format) ────────────────────────────────────

export function parseCodexStream(cardId: string, res: IncomingMessage): void {
  let buffer = ''

  res.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') {
        sendStream(cardId, { cardId, type: 'done' })
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
          sendStream(cardId, { cardId, type: 'done' })
        }
      } catch { /* non-JSON */ }
    }
  })

  res.on('error', err => sendStream(cardId, { cardId, type: 'error', error: err.message }))
  res.on('end', () => sendStream(cardId, { cardId, type: 'done' }))
}

// ─── Pi streaming (newline-delimited JSON) ───────────────────────────────────

export function parsePiStream(cardId: string, res: IncomingMessage): void {
  let buffer = ''

  res.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const evt = JSON.parse(line)
        // Pi emits { type: 'text', content: '...' } or { type: 'done' }
        if (evt.type === 'text' || evt.type === 'content') {
          sendStream(cardId, { cardId, type: 'text', text: evt.content ?? evt.text ?? '' })
        } else if (evt.type === 'tool_call' || evt.type === 'tool_use') {
          sendStream(cardId, { cardId, type: 'tool_use', toolName: evt.name ?? evt.tool, toolInput: evt.input ?? evt.arguments })
        } else if (evt.type === 'done' || evt.type === 'end') {
          sendStream(cardId, { cardId, type: 'done' })
        } else if (evt.type === 'error') {
          sendStream(cardId, { cardId, type: 'error', error: evt.message ?? evt.error })
        }
      } catch { /* non-JSON */ }
    }
  })

  res.on('error', err => sendStream(cardId, { cardId, type: 'error', error: err.message }))
  res.on('end', () => sendStream(cardId, { cardId, type: 'done' }))
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

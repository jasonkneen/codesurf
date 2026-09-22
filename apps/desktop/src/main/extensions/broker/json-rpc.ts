/**
 * JsonRpcPeer — electron-free, newline-delimited JSON-RPC 2.0 transport.
 *
 * Extracted from src/main/owl/runtime.ts so child-process bundles (which must
 * NOT import electron) can use the same framing as the main-process OWL host.
 * owl/runtime.ts re-imports and re-exports from here; no behaviour changes.
 *
 * NOTE: This file avoids TypeScript parameter properties (private readonly x)
 * so it can be loaded in Node's strip-only mode by tests without a compiler.
 */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

interface RpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: JsonValue
  error?: { code: number; message: string }
}

export type RpcHandler = (method: string, params: JsonObject) => Promise<JsonValue> | JsonValue

export class JsonRpcPeer {
  private nextId: number
  private buffer: string
  private closed: boolean
  private pending: Map<number, { resolve: (value: JsonValue) => void; reject: (error: Error) => void }>
  private writeLine: (line: string) => void
  private handler: RpcHandler | undefined

  constructor(
    writeLine: (line: string) => void,
    handler?: RpcHandler,
  ) {
    this.writeLine = writeLine
    this.handler = handler
    this.nextId = 1
    this.buffer = ''
    this.closed = false
    this.pending = new Map()
  }

  call<T extends JsonValue = JsonValue>(method: string, params: JsonObject = {}, timeoutMs = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('RPC transport is closed'))
    const request = { jsonrpc: '2.0' as const, id: this.nextId++, method, params }

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.id)
        reject(new Error(`RPC request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(request.id, {
        resolve: value => {
          clearTimeout(timeout)
          resolve(value as T)
        },
        reject: error => {
          clearTimeout(timeout)
          reject(error)
        },
      })
      try {
        this.writeLine(JSON.stringify(request))
      } catch (error) {
        this.pending.delete(request.id)
        clearTimeout(timeout)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  feed(chunk: string): void {
    if (this.closed) return
    this.buffer += chunk
    while (true) {
      const idx = this.buffer.indexOf('\n')
      if (idx < 0) break
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (line.length > 0) void this.handleLine(line)
    }
  }

  close(reason = 'RPC transport closed'): void {
    if (this.closed) return
    this.closed = true
    const error = new Error(reason)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private async handleLine(line: string): Promise<void> {
    let message: { id?: unknown; method?: unknown; params?: unknown; error?: { message?: unknown }; result?: JsonValue }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }

    if (typeof message.method === 'string') {
      if (!this.handler || typeof message.id !== 'number') return
      try {
        const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params)
          ? message.params as JsonObject
          : {}
        const result = await this.handler(message.method, params)
        this.writeLine(JSON.stringify({ jsonrpc: '2.0', id: message.id, result } satisfies RpcResponse))
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error)
        this.writeLine(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: err } } satisfies RpcResponse))
      }
      return
    }

    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(String(message.error.message ?? 'RPC request failed')))
    else pending.resolve(message.result ?? null)
  }
}

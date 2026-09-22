/**
 * Extension local-proxy transport — HTTP POST to an Anthropic-/messages-shaped endpoint.
 */

import * as http from 'http'
import * as https from 'https'
import { parseClaudeStream } from '../../agent-stream'
import { ensureLocalProxyRunning, getProxyStatus } from '../../ipc/localProxy'
import type { ChatRequest } from '../types'
import {
  BoundedTextAccumulator,
  MAX_PROVIDER_ACCUMULATED_OUTPUT_BYTES,
  MAX_PROVIDER_DIAGNOSTIC_BYTES,
} from '../bounded-output.ts'
import {
  LocalProxyStreamBudget,
  LOCAL_PROXY_DIAGNOSTIC_TRUNCATED,
  boundLocalProxyDiagnostic,
} from '../provider-history.ts'
import { LocalProxyTurnFence } from '../local-proxy-turn-fence.ts'
import {
  isHostResolvedChatTransport,
} from '../provider-registry.ts'
import { prepareLocalProxyRequest } from '../local-proxy-request.ts'
import { isProviderAcceptanceEvent } from '../provider-acceptance.ts'
import {
  classifyLocalProxyParserDone,
  localProxyRequestCloseNeedsFailure,
  LocalProxyProtocolTerminalTracker,
  monitorLocalProxyProtocolChunk,
} from '../local-proxy-resource-limits.ts'
import {
  activeHttpRequests,
  chatRequestScope,
  chatStreamScopeKey,
  markRoomPromptAccepted,
  sendStream,
  type ChatStreamScope,
} from '../runtime'

const localProxyTurns = new LocalProxyTurnFence()

export function stopLocalProxyTurn(scope: ChatStreamScope): void {
  const scopeKey = chatStreamScopeKey(scope)
  localProxyTurns.invalidate(scopeKey)
  const request = activeHttpRequests.get(scopeKey)
  if (!request) return
  activeHttpRequests.delete(scopeKey)
  request.destroy()
}

function bufferHttpResponse(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const output = new BoundedTextAccumulator(MAX_PROVIDER_DIAGNOSTIC_BYTES, LOCAL_PROXY_DIAGNOSTIC_TRUNCATED)
    let settled = false
    const finish = (value: string): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    res.on('data', (chunk: Buffer) => {
      output.append(chunk.toString('utf8'))
      if (output.truncated) {
        finish(output.value)
        res.destroy()
      }
    })
    res.on('end', () => finish(output.value))
    res.on('error', error => {
      if (settled) return
      reject(error)
    })
  })
}

export function chatLocalProxy(req: ChatRequest): void {
  const scope = chatRequestScope(req)
  const scopeKey = chatStreamScopeKey(scope)
  const transport = req.providerTransport
  if (!isHostResolvedChatTransport(transport)) {
    sendStream(scope, { type: 'error', error: `Unsupported provider: ${req.provider}` })
    sendStream(scope, { type: 'done' })
    return
  }

  const turnToken = localProxyTurns.begin(scopeKey)
  const replacedRequest = activeHttpRequests.get(scopeKey)
  if (replacedRequest) {
    activeHttpRequests.delete(scopeKey)
    replacedRequest.destroy()
  }
  const isCurrentTurn = (): boolean => localProxyTurns.isCurrent(scopeKey, turnToken)

  void (async () => {
    let managedLoopback: { port: number; token: string } | undefined
    if (transport.hostAuthority.trust === 'installed-loopback') {
      if (transport.autoStart !== false) {
        const started = await ensureLocalProxyRunning()
        if (!started.ok) {
          throw new Error(started.message || 'Failed to start the local proxy')
        }
      }
      if (!isCurrentTurn()) return
      const status = getProxyStatus()
      if (!status.running || !status.token) {
        throw new Error('The host-managed local proxy is not running')
      }
      managedLoopback = { port: status.port, token: status.token }
    }
    const plan = prepareLocalProxyRequest(req, managedLoopback)
    if (!isCurrentTurn()) return

    const requestModule = plan.targetUrl.protocol === 'https:' ? https : http
    let request: http.ClientRequest
    let activeResponse: http.IncomingMessage | null = null
    const isCurrentRequest = (): boolean => (
      isCurrentTurn()
      && activeHttpRequests.get(scopeKey) === request
    )
    const finishCurrentRequest = (): boolean => {
      if (!isCurrentRequest()) return false
      activeHttpRequests.delete(scopeKey)
      return localProxyTurns.finish(scopeKey, turnToken)
    }
    const failCurrentRequest = (message: string): void => {
      if (!finishCurrentRequest()) return
      activeResponse?.destroy()
      if (!request.destroyed) request.destroy()
      sendStream(scope, { type: 'error', error: boundLocalProxyDiagnostic(message) })
      sendStream(scope, { type: 'done' })
    }
    let responseObserved = false

    request = requestModule.request(plan.requestOptions, (res) => {
      responseObserved = true
      activeResponse = res
      if (!isCurrentRequest()) {
        res.destroy()
        return
      }
      if ((res.statusCode ?? 500) >= 400) {
        void bufferHttpResponse(res).then((raw) => {
          if (!finishCurrentRequest()) return
          let errorMessage = `Proxy request failed (${res.statusCode ?? 500})`
          try {
            const parsed = JSON.parse(raw)
            errorMessage = boundLocalProxyDiagnostic(parsed?.error?.message ?? errorMessage)
          } catch {
            if (raw.trim()) errorMessage = boundLocalProxyDiagnostic(raw)
          }
          sendStream(scope, { type: 'error', error: errorMessage })
          sendStream(scope, { type: 'done' })
        }).catch((err: Error) => {
          if (!finishCurrentRequest()) return
          sendStream(scope, { type: 'error', error: boundLocalProxyDiagnostic(err.message) })
          sendStream(scope, { type: 'done' })
        })
        return
      }

      let terminal = false
      let promptAccepted = false
      let providerErrorReported = false
      const acceptPrompt = (): void => {
        if (promptAccepted) return
        promptAccepted = true
        markRoomPromptAccepted(scope)
      }
      const failStream = (message?: string): void => {
        if (terminal) return
        terminal = true
        if (!finishCurrentRequest()) return
        res.destroy()
        if (!request.destroyed) request.destroy()
        if (message && !providerErrorReported) {
          sendStream(scope, { type: 'error', error: boundLocalProxyDiagnostic(message) })
        }
        sendStream(scope, { type: 'done' })
      }
      const protocolTerminal = new LocalProxyProtocolTerminalTracker()
      res.on('data', (chunk: Buffer) => {
        monitorLocalProxyProtocolChunk(protocolTerminal, chunk, () => {
          failStream('Proxy stream exceeded the managed response limit')
        })
      })
      res.on('close', () => {
        if (terminal) return
        failStream(providerErrorReported ? undefined : 'Proxy stream closed before completion')
      })
      const outputBudget = new LocalProxyStreamBudget(MAX_PROVIDER_ACCUMULATED_OUTPUT_BYTES)
      parseClaudeStream(req.cardId, res, event => {
        if (terminal || !isCurrentRequest()) return
        if (event.type === 'error') {
          providerErrorReported = true
          sendStream(scope, {
            type: 'error',
            error: boundLocalProxyDiagnostic(event.error ?? 'Proxy stream error'),
          })
          failStream()
          return
        }
        if (event.type === 'done') {
          const completion = classifyLocalProxyParserDone(
            protocolTerminal.hasProvenTerminal,
            providerErrorReported,
          )
          if (completion !== 'complete') {
            failStream(completion === 'missing-terminal'
              ? 'Proxy stream ended without an explicit protocol terminal event'
              : undefined)
            return
          }
          acceptPrompt()
          terminal = true
          if (!finishCurrentRequest()) return
          res.destroy()
          sendStream(scope, { type: 'done' })
          return
        }
        if (isProviderAcceptanceEvent(event)) acceptPrompt()
        for (const boundedEvent of outputBudget.accept(event)) {
          sendStream(scope, { ...boundedEvent })
        }
        if (outputBudget.exhausted) {
          terminal = true
          if (!finishCurrentRequest()) return
          res.destroy()
          sendStream(scope, { type: 'done' })
        }
      })
    })

    request.on('timeout', () => {
      if (isCurrentRequest()) request.destroy(new Error('Proxy request timed out'))
    })

    request.on('error', (err) => {
      failCurrentRequest(err.message)
    })

    request.on('upgrade', (_res, socket) => {
      responseObserved = true
      socket.destroy()
      failCurrentRequest('Proxy returned an unsupported protocol upgrade')
    })

    request.on('close', () => {
      if (!localProxyRequestCloseNeedsFailure(responseObserved)) return
      failCurrentRequest('Proxy request closed before a response was received')
    })

    if (!isCurrentTurn()) {
      request.destroy()
      return
    }
    activeHttpRequests.set(scopeKey, request)
    request.write(plan.body)
    request.end()
  })().catch((err: Error) => {
    if (!localProxyTurns.finish(scopeKey, turnToken)) return
    sendStream(scope, { type: 'error', error: boundLocalProxyDiagnostic(err.message) })
    sendStream(scope, { type: 'done' })
  })
}

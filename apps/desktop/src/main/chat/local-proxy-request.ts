import type { RequestOptions } from 'http'
import type { ChatRequest } from './types.ts'
import { boundLocalProxyMessages } from './provider-history.ts'
import {
  isHostResolvedChatTransport,
  type HostResolvedChatTransport,
} from './provider-registry.ts'

export interface LocalProxyRequestPlan {
  transport: HostResolvedChatTransport
  targetUrl: URL
  body: string
  requestOptions: RequestOptions
}

export interface ManagedLoopbackEndpoint {
  port: number
  token: string
}

function validatedManagedLoopbackEndpoint(
  value: ManagedLoopbackEndpoint | undefined,
): ManagedLoopbackEndpoint {
  const port = Number(value?.port)
  const token = typeof value?.token === 'string' ? value.token.trim() : ''
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('The host-managed local proxy port is unavailable')
  }
  if (!token || Buffer.byteLength(token, 'utf8') > 8_192 || /[\r\n\0]/.test(token)) {
    throw new Error('The host-managed local proxy token is unavailable')
  }
  return { port, token }
}

/** Validate host authority and create the complete bounded HTTP request before network I/O. */
export function prepareLocalProxyRequest(
  req: ChatRequest,
  managedLoopback?: ManagedLoopbackEndpoint,
): LocalProxyRequestPlan {
  const transport = req.providerTransport
  if (!isHostResolvedChatTransport(transport)) {
    throw new Error('Local proxy requests require a host-resolved provider transport')
  }
  const runtimeTransport = transport.hostAuthority.trust === 'installed-loopback'
    ? (() => {
        const endpoint = validatedManagedLoopbackEndpoint(managedLoopback)
        return {
          baseUrl: `http://127.0.0.1:${endpoint.port}/v1`,
          apiKey: endpoint.token,
        }
      })()
    : {
        baseUrl: transport.baseUrl,
        apiKey: transport.apiKey,
      }
  const baseUrl = runtimeTransport.baseUrl.replace(/\/+$/, '')
  const targetUrl = new URL(`${baseUrl}/messages`)
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    throw new Error('Local proxy transport must use HTTP or HTTPS')
  }
  const preparedMessages = Array.isArray(req.expandedMessages) && req.expandedMessages.length > 0
    ? req.expandedMessages
    : req.messages
  const boundedHistory = boundLocalProxyMessages(preparedMessages)
  const body = JSON.stringify({
    model: req.model,
    stream: true,
    max_tokens: 4096,
    ...(req.contextPrompt ? { system: req.contextPrompt } : {}),
    messages: boundedHistory.messages,
  })
  const requestOptions: RequestOptions = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port ? Number(targetUrl.port) : targetUrl.protocol === 'https:' ? 443 : 80,
    path: `${targetUrl.pathname}${targetUrl.search}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'anthropic-version': '2023-06-01',
      ...(runtimeTransport.apiKey ? {
        'x-api-key': runtimeTransport.apiKey,
        Authorization: `Bearer ${runtimeTransport.apiKey}`,
      } : {}),
    },
    timeout: 120_000,
  }
  const plan = { transport, targetUrl, body, requestOptions }
  return plan
}

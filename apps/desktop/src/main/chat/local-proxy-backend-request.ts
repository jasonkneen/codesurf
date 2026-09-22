import * as http from 'node:http'
import { localProxyRequestCloseNeedsFailure } from './local-proxy-resource-limits.ts'

export interface GuardedLocalProxyBackendRequestHandlers {
  onResponse: (response: http.IncomingMessage) => void
  onFailure: (message: string) => void
}

/**
 * Create a backend request whose pre-response lifecycle always settles. Node's
 * HTTP client emits neither `response` nor `error` for a successful protocol
 * upgrade, and a peer can also close silently before headers. Both cases must
 * fail immediately instead of stranding the outer Anthropic response until its
 * long request timeout.
 */
export function createGuardedLocalProxyBackendRequest(
  options: http.RequestOptions,
  handlers: GuardedLocalProxyBackendRequestHandlers,
): http.ClientRequest {
  let responseObserved = false
  let failureReported = false
  const fail = (message: string): void => {
    if (failureReported) return
    failureReported = true
    handlers.onFailure(message)
  }

  const request = http.request(options, response => {
    responseObserved = true
    handlers.onResponse(response)
  })
  request.on('timeout', () => {
    request.destroy(new Error('Backend request timed out'))
  })
  request.on('error', error => {
    fail(error.message === 'Backend request timed out'
      ? error.message
      : 'Backend unreachable')
  })
  request.on('upgrade', (_response, socket) => {
    responseObserved = true
    socket.destroy()
    fail('Backend returned an unsupported protocol upgrade')
  })
  request.on('close', () => {
    if (localProxyRequestCloseNeedsFailure(responseObserved)) {
      fail('Backend request closed before a response was received')
    }
  })
  return request
}

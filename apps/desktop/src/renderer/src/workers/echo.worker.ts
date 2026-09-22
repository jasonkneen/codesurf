/**
 * Echo worker — Phase 0 smoke test for Vite + electron-vite worker bundling.
 *
 * Receives `{ requestId, payload }`, replies `{ requestId, payload }`.
 * Lets us verify the toolchain works under Electron's renderer protocol
 * before wiring up the real (non-trivial) discovery-graph worker.
 *
 * Safe to delete once Phase 1 lands.
 */

interface EchoMessage {
  requestId: number
  payload: unknown
}

self.onmessage = (e: MessageEvent<EchoMessage>) => {
  const { requestId, payload } = e.data
  // Tag the response so callers can distinguish it from production worker output.
  ;(self as unknown as Worker).postMessage({ requestId, payload, _echo: true })
}

// Default export so TS treats this as a module (avoids isolatedModules warnings).
export {}

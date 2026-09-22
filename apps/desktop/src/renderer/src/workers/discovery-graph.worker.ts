/**
 * Discovery graph worker.
 *
 * Receives a serialized DiscoveryWorkerInput, runs the O(n²) pairwise
 * connection finder off the main thread, returns the serialized
 * DiscoveryWorkerOutput (Sets/Maps flattened to arrays).
 *
 * Scope: only the heavy `findDiscoveryConnections` step. Suppressed/locked/
 * cascade/addAssociated post-processing stays on the main thread because it
 * operates on the already-computed graph (cheap) and depends on closures over
 * mutable React state (awkward to serialize).
 */
import { runDiscoveryPipeline } from './discovery-graph-impl'
import type { DiscoveryWorkerInput, DiscoveryWorkerOutput } from './discovery-graph-impl'

interface IncomingMessage {
  requestId: number
  payload: DiscoveryWorkerInput
}

interface OutgoingMessage {
  requestId: number
  payload?: DiscoveryWorkerOutput
  error?: string
}

self.onmessage = (e: MessageEvent<IncomingMessage>) => {
  const { requestId, payload } = e.data
  try {
    const result = runDiscoveryPipeline(payload)
    const response: OutgoingMessage = { requestId, payload: result }
    ;(self as unknown as Worker).postMessage(response)
  } catch (err) {
    const response: OutgoingMessage = { requestId, error: err instanceof Error ? err.message : String(err) }
    ;(self as unknown as Worker).postMessage(response)
  }
}

export {}

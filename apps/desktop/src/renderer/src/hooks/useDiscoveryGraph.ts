/**
 * useDiscoveryGraph — runs findDiscoveryConnections off the main thread when
 * tile count justifies the postMessage overhead, falls back to inline
 * computation otherwise.
 *
 * Behavior contract (see .planning/worker-optimization.md decisions):
 *   • Q1 (worker fail): silent fallback to main-thread (handled inside useWorker).
 *   • Q2 (cadence): no throttle; last-write-wins on receive.
 *   • Q3 (threshold): tiles.length < 10 ⇒ inline. ≥10 ⇒ worker.
 *
 * The hook returns the discovery graph as a `DiscoveryState` (Set/Map shape)
 * — same as App.tsx's existing `findDiscoveryConnections` return — so the
 * call-site change is minimal: replace the synchronous function call with
 * `useDiscoveryGraph(...)`.
 *
 * Caveat: when `tiles.length >= threshold`, the result is async; on first
 * dispatch (or while the worker is computing the latest input), we return
 * the previous result so the canvas doesn't flicker connections off/on.
 * If no previous result exists yet, we return an empty graph rather than
 * blocking the render.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useWorker } from './useWorker'
import {
  runDiscoveryPipeline,
  deserializeDiscoveryOutput,
  type DiscoveryState,
  type DiscoveryWorkerInput,
  type DiscoveryWorkerOutput,
} from '../workers/discovery-graph-impl'
import DiscoveryWorker from '../workers/discovery-graph.worker?worker&inline'
import type { TileState } from '../../../shared/types'

const WORKER_THRESHOLD = 10  // Q3 — n<10 runs inline

export interface UseDiscoveryGraphInputs {
  tiles: TileState[]
  hiddenTileIds: Set<string>
  gridStep: number
  maxDistance: number
  /** Per-tile dynamic extension actions (registered at runtime). */
  extActionsByTileId: Map<string, string[]>
  /** When false, returns an empty graph (used to gate auto-connections). */
  enabled: boolean
}

const EMPTY_GRAPH: DiscoveryState = {
  connectedTileIds: new Set(),
  byTile: new Map(),
}

export function useDiscoveryGraph(inputs: UseDiscoveryGraphInputs): DiscoveryState {
  const { tiles, hiddenTileIds, gridStep, maxDistance, extActionsByTileId, enabled } = inputs

  // Build a stable, serializable payload. We rely on referential equality
  // of `tiles`, `hiddenTileIds`, etc. — caller (App.tsx) already memoizes
  // these as state, so referential changes correspond to real changes.
  const useWorkerPath = enabled && tiles.length >= WORKER_THRESHOLD
  const useInlinePath = enabled && !useWorkerPath

  const workerInput = useMemo<DiscoveryWorkerInput | null>(() => {
    if (!useWorkerPath) return null
    return {
      tiles,
      hiddenTileIds: Array.from(hiddenTileIds),
      gridStep,
      maxDistance,
      extActions: Array.from(extActionsByTileId.entries()),
    }
  }, [useWorkerPath, tiles, hiddenTileIds, gridStep, maxDistance, extActionsByTileId])

  const inlineResult = useMemo<DiscoveryState>(() => {
    if (!useInlinePath) return EMPTY_GRAPH
    const payload: DiscoveryWorkerInput = {
      tiles,
      hiddenTileIds: Array.from(hiddenTileIds),
      gridStep,
      maxDistance,
      extActions: Array.from(extActionsByTileId.entries()),
    }
    return deserializeDiscoveryOutput(runDiscoveryPipeline(payload))
  }, [useInlinePath, tiles, hiddenTileIds, gridStep, maxDistance, extActionsByTileId])

  const { result: workerOut } = useWorker<DiscoveryWorkerInput, DiscoveryWorkerOutput>(
    workerInput,
    {
      workerFactory: () => new DiscoveryWorker(),
      // Inline fallback when the worker fails to init — runs synchronously
      // on main thread. Same code path as the n<10 case.
      fallback: (input) => runDiscoveryPipeline(input),
    },
  )

  // Memoize deserialization so consumers see a stable Set/Map reference
  // until a new worker result arrives — important for downstream useMemos
  // that depend on graph identity.
  const workerGraph = useMemo<DiscoveryState | null>(
    () => (workerOut ? deserializeDiscoveryOutput(workerOut) : null),
    [workerOut],
  )

  // Cache the most recent worker result so we don't flicker to empty
  // while a new request is in flight (e.g. mid-drag).
  const lastWorkerGraphRef = useRef<DiscoveryState>(EMPTY_GRAPH)
  useEffect(() => {
    if (workerGraph) lastWorkerGraphRef.current = workerGraph
  }, [workerGraph])

  if (!enabled) return EMPTY_GRAPH
  if (useInlinePath) return inlineResult
  // Worker path: prefer freshly-deserialized current result; if not yet
  // available, return the cached previous result (or empty on first run).
  return workerGraph ?? lastWorkerGraphRef.current
}

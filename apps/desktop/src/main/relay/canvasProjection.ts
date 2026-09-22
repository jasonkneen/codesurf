import type { TileState } from '../../shared/types'
import { getWorkspacePathById } from '../ipc/workspace'
import { WorkspaceLatestEffectQueue } from '../storage/workspaceLatestEffectQueue'
import {
  captureRelayHostGeneration,
  isRelayHostGenerationActive,
} from './registration'
import {
  captureRelayServiceGeneration,
  isRelayServiceGenerationActive,
  syncWorkspaceRelayParticipants,
} from './service'

export type CanvasRelayProjectionToken = {
  hostGeneration: number
  serviceGeneration: number
}

type CanvasRelayProjection = CanvasRelayProjectionToken & {
  tiles: TileState[]
}

function isProjectionTokenActive(token: CanvasRelayProjectionToken): boolean {
  return isRelayHostGenerationActive(token.hostGeneration)
    && isRelayServiceGenerationActive(token.serviceGeneration)
}

const projectionQueue = new WorkspaceLatestEffectQueue<CanvasRelayProjection>(
  async (workspaceId, projection, context) => {
    const isActive = (): boolean => (
      context.isActive() && isProjectionTokenActive(projection)
    )
    if (!isActive()) return

    const workspacePath = await getWorkspacePathById(workspaceId)
    if (!workspacePath || !isActive()) return

    await syncWorkspaceRelayParticipants(
      workspaceId,
      workspacePath,
      projection.tiles,
      { isActive },
    )
  },
  (_workspaceId, error) => {
    console.warn('[Canvas] relay participant sync skipped:', error)
  },
)
projectionQueue.deactivate()

export function captureCanvasRelayProjectionToken(): CanvasRelayProjectionToken | null {
  const hostGeneration = captureRelayHostGeneration()
  const serviceGeneration = captureRelayServiceGeneration()
  if (hostGeneration === null || serviceGeneration === null) return null
  return { hostGeneration, serviceGeneration }
}

export function scheduleCanvasRelayProjection(
  workspaceId: string,
  token: CanvasRelayProjectionToken,
  tiles: TileState[],
): boolean {
  if (!isProjectionTokenActive(token)) return false
  return projectionQueue.schedule(workspaceId, {
    ...token,
    tiles: tiles.map(tile => ({ ...tile })),
  })
}

export function activateCanvasRelayProjectionSync(): void {
  projectionQueue.activate()
}

export function deactivateCanvasRelayProjectionSync(): void {
  projectionQueue.deactivate()
}

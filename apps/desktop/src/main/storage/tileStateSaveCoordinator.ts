import { WorkspaceSaveArbiter } from './workspaceSaveArbiter.ts'

/**
 * Serializes the read/merge/write transaction for one tile-state artifact.
 * Different tiles remain independent, while failures and settled lanes inherit
 * WorkspaceSaveArbiter's recovery and cleanup behavior.
 */
export class TileStateSaveCoordinator {
  private readonly arbiter = new WorkspaceSaveArbiter()

  get activeLaneCount(): number {
    return this.arbiter.activeLaneCount
  }

  run<T>(storageId: string, tileId: string, operation: () => Promise<T>): Promise<T> {
    return this.arbiter.run(JSON.stringify([storageId, tileId]), operation)
  }
}

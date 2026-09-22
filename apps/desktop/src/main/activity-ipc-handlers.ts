import type {
  ActivityHealthSnapshot,
  ActivityQuery,
  ActivityRecord,
  ActivityUpsertInput,
} from '../shared/activity-types.ts'
import {
  validateActivityId,
  validateActivityQuery,
  validateActivityTileId,
  validateActivityUpsertInput,
  validateActivityWorkspaceId,
} from './activity-validation.ts'

export interface ActivityIPCService {
  upsert(workspaceId: string, data: ActivityUpsertInput): Promise<ActivityRecord>
  query(query: ActivityQuery): Promise<ActivityRecord[]>
  byTile(workspaceId: string, tileId: string): Promise<ActivityRecord[]>
  delete(workspaceId: string, tileId: string, id: string): Promise<boolean>
  clearTile(workspaceId: string, tileId: string): Promise<number>
  byAgent(workspaceId: string): Promise<Record<string, ActivityRecord[]>>
  health(workspaceId: string): Promise<ActivityHealthSnapshot>
}

export function createActivityIPCHandlers(service: ActivityIPCService) {
  return {
    'activity:upsert': (_event: unknown, workspaceId: unknown, data: unknown) => (
      service.upsert(
        validateActivityWorkspaceId(workspaceId),
        validateActivityUpsertInput(data),
      )
    ),
    'activity:query': (_event: unknown, query: unknown) => (
      service.query(validateActivityQuery(query))
    ),
    'activity:byTile': (_event: unknown, workspaceId: unknown, tileId: unknown) => (
      service.byTile(
        validateActivityWorkspaceId(workspaceId),
        validateActivityTileId(tileId),
      )
    ),
    'activity:delete': (
      _event: unknown,
      workspaceId: unknown,
      tileId: unknown,
      id: unknown,
    ) => (
      service.delete(
        validateActivityWorkspaceId(workspaceId),
        validateActivityTileId(tileId),
        validateActivityId(id),
      )
    ),
    'activity:clearTile': (_event: unknown, workspaceId: unknown, tileId: unknown) => (
      service.clearTile(
        validateActivityWorkspaceId(workspaceId),
        validateActivityTileId(tileId),
      )
    ),
    'activity:byAgent': (_event: unknown, workspaceId: unknown) => (
      service.byAgent(validateActivityWorkspaceId(workspaceId))
    ),
    'activity:health': (_event: unknown, workspaceId: unknown) => (
      service.health(validateActivityWorkspaceId(workspaceId))
    ),
  }
}

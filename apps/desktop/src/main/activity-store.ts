import type {
  ActivityQuery,
  ActivityHealthSnapshot,
  ActivityRecord,
  ActivityUpsertInput,
} from '../shared/activity-types.ts'
import { CODESURF_HOME } from './paths.ts'
import { createFileActivityPersistence } from './activity-persistence.ts'
import { ActivityStore } from './activity-store-core.ts'

export {
  MAX_ACTIVITY_RECORDS,
  MAX_ACTIVITY_AGE_MS,
  capActivityRecords,
} from './activity-cap.ts'

const activityStore = new ActivityStore({
  persistence: createFileActivityPersistence({ homeDir: CODESURF_HOME }),
})

export function upsertActivity(
  workspaceId: string,
  data: ActivityUpsertInput,
): Promise<ActivityRecord> {
  return activityStore.upsert(workspaceId, data)
}

export function queryActivity(query: ActivityQuery): Promise<ActivityRecord[]> {
  return activityStore.query(query)
}

export function getActivityByTile(
  workspaceId: string,
  tileId: string,
): Promise<ActivityRecord[]> {
  return activityStore.byTile(workspaceId, tileId)
}

export function deleteActivity(
  workspaceId: string,
  tileId: string,
  id: string,
): Promise<boolean> {
  return activityStore.delete(workspaceId, tileId, id)
}

export function clearTileActivity(workspaceId: string, tileId: string): Promise<number> {
  return activityStore.clearTile(workspaceId, tileId)
}

export function getActivityByAgent(
  workspaceId: string,
): Promise<Record<string, ActivityRecord[]>> {
  return activityStore.byAgent(workspaceId)
}

export function getActivityHealth(workspaceId: string): Promise<ActivityHealthSnapshot> {
  return Promise.resolve(activityStore.getHealth(workspaceId))
}

/** Enter the shutdown barrier and durably drain every accepted mutation. */
export function flushAll(): Promise<void> {
  return activityStore.flushAll()
}

import { randomUUID } from 'node:crypto'
import type {
  ActivityHealthEvent,
  ActivityHealthOperation,
  ActivityHealthSnapshot,
  ActivityMetadata,
  ActivityQuery,
  ActivityRecord,
} from '../shared/activity-types.ts'
import { capActivityRecords } from './activity-cap.ts'
import {
  activityDocumentByteLengthFromRecordBytes,
  activityRecordByteLength,
} from './activity-document-format.ts'
import {
  ActivityPersistenceError,
  type ActivityPersistence,
} from './activity-persistence.ts'
import {
  MAX_ACTIVITY_FILE_BYTES,
  MAX_ACTIVITY_QUERY_LIMIT,
  MAX_ACTIVITY_QUERY_RESPONSE_BYTES,
  validateActivityMetadata,
  validateActivityId,
  validateActivityQuery,
  validateActivityTileId,
  validateActivityUpsertInput,
  validateActivityWorkspaceId,
} from './activity-validation.ts'

export const DEFAULT_ACTIVITY_SAVE_DEBOUNCE_MS = 1000
export const DEFAULT_ACTIVITY_SAVE_RETRY_MS = 1000
export const DEFAULT_ACTIVITY_MAX_SAVE_RETRY_MS = 60_000
export const DEFAULT_MAX_LOADED_ACTIVITY_WORKSPACES = 32
export const DEFAULT_ACTIVITY_HEALTH_EVENT_INTERVAL_MS = 30_000

export interface ActivityScheduler {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

export interface ActivityStoreOptions {
  persistence: ActivityPersistence
  now?: () => number
  createId?: () => string
  scheduler?: ActivityScheduler
  saveDebounceMs?: number
  saveRetryMs?: number
  maxSaveRetryMs?: number
  maxLoadedWorkspaces?: number
  maxFileBytes?: number
  maxQueryResponseBytes?: number
  measureRecordBytes?: (record: ActivityRecord) => number
  healthEventIntervalMs?: number
  onHealthEvent?: (event: ActivityHealthEvent) => void
}

interface StoreState {
  workspaceId: string
  records: ActivityRecord[]
  recordBytes: number[]
  documentBytes: number
  generation: number
  persistedGeneration: number
  saveTimer: unknown | null
  persistPromise: Promise<void> | null
  lastSaveError: unknown
  saveFailureCount: number
  lastAccess: number
  activeUsers: number
}

export interface ActivityStoreStats {
  loadedWorkspaceIds: string[]
  loadingWorkspaceIds: string[]
  dirtyWorkspaceIds: string[]
}

export class ActivityStoreClosedError extends Error {
  constructor() {
    super('Activity store is closing')
    this.name = 'ActivityStoreClosedError'
  }
}

export class ActivityStoreCapacityError extends Error {
  readonly code = 'capacity_exhausted'

  constructor() {
    super('Activity workspace capacity is exhausted')
    this.name = 'ActivityStoreCapacityError'
  }
}

const defaultScheduler: ActivityScheduler = {
  set(callback, delayMs) {
    const handle = setTimeout(callback, delayMs)
    handle.unref?.()
    return handle
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

function cloneRecord(record: ActivityRecord): ActivityRecord {
  return {
    ...record,
    ...(record.metadata === undefined
      ? {}
      : { metadata: { ...record.metadata } }),
  }
}

function cloneRecords(records: ActivityRecord[]): ActivityRecord[] {
  return records.map(cloneRecord)
}

function mergeMetadata(
  existing: ActivityMetadata | undefined,
  patch: ActivityMetadata | undefined,
): ActivityMetadata | undefined {
  if (patch === undefined) return existing
  return Object.fromEntries([
    ...Object.entries(existing ?? {}),
    ...Object.entries(patch),
  ])
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`)
  return value
}

export class ActivityStore {
  private readonly persistence: ActivityPersistence
  private readonly now: () => number
  private readonly createId: () => string
  private readonly scheduler: ActivityScheduler
  private readonly saveDebounceMs: number
  private readonly saveRetryMs: number
  private readonly maxSaveRetryMs: number
  private readonly maxLoadedWorkspaces: number
  private readonly maxFileBytes: number
  private readonly maxQueryResponseBytes: number
  private readonly measureRecordBytes: (record: ActivityRecord) => number
  private readonly healthEventIntervalMs: number
  private readonly onHealthEvent: ((event: ActivityHealthEvent) => void) | undefined
  private readonly stores = new Map<string, StoreState>()
  private readonly loads = new Map<string, Promise<StoreState>>()
  private readonly pendingAcquires = new Map<string, number>()
  private readonly admittedLoads = new Set<string>()
  private pendingAdmissionWorkspace: string | null = null
  private readonly health = new Map<string, ActivityHealthSnapshot>()
  private readonly healthEventTimes = new Map<string, number>()
  private accessSequence = 0
  private evictionTail: Promise<void> = Promise.resolve()
  private closing = false
  private activeOperations = 0
  private readonly operationWaiters: Array<() => void> = []

  constructor(options: ActivityStoreOptions) {
    this.persistence = options.persistence
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
    this.scheduler = options.scheduler ?? defaultScheduler
    this.saveDebounceMs = assertPositiveInteger(
      options.saveDebounceMs ?? DEFAULT_ACTIVITY_SAVE_DEBOUNCE_MS,
      'saveDebounceMs',
    )
    this.saveRetryMs = assertPositiveInteger(
      options.saveRetryMs ?? DEFAULT_ACTIVITY_SAVE_RETRY_MS,
      'saveRetryMs',
    )
    this.maxSaveRetryMs = assertPositiveInteger(
      options.maxSaveRetryMs ?? DEFAULT_ACTIVITY_MAX_SAVE_RETRY_MS,
      'maxSaveRetryMs',
    )
    if (this.maxSaveRetryMs < this.saveRetryMs) {
      throw new TypeError('maxSaveRetryMs cannot be less than saveRetryMs')
    }
    this.maxLoadedWorkspaces = assertPositiveInteger(
      options.maxLoadedWorkspaces ?? DEFAULT_MAX_LOADED_ACTIVITY_WORKSPACES,
      'maxLoadedWorkspaces',
    )
    this.maxFileBytes = assertPositiveInteger(
      options.maxFileBytes ?? MAX_ACTIVITY_FILE_BYTES,
      'maxFileBytes',
    )
    this.maxQueryResponseBytes = assertPositiveInteger(
      options.maxQueryResponseBytes ?? MAX_ACTIVITY_QUERY_RESPONSE_BYTES,
      'maxQueryResponseBytes',
    )
    this.measureRecordBytes = options.measureRecordBytes ?? activityRecordByteLength
    this.healthEventIntervalMs = assertPositiveInteger(
      options.healthEventIntervalMs ?? DEFAULT_ACTIVITY_HEALTH_EVENT_INTERVAL_MS,
      'healthEventIntervalMs',
    )
    this.onHealthEvent = options.onHealthEvent
  }

  private healthErrorCode(error: unknown): string {
    if (error instanceof ActivityPersistenceError) return error.code
    if (error instanceof ActivityStoreCapacityError) return error.code
    return 'operation_failed'
  }

  private recordHealthFailure(
    workspaceId: string,
    operation: ActivityHealthOperation,
    error: unknown,
  ): void {
    const occurredAt = this.now()
    const code = this.healthErrorCode(error)
    const lastIssue = { operation, code, occurredAt }
    this.health.set(workspaceId, {
      available: true,
      status: 'degraded',
      lastIssue,
    })
    const eventKey = `${workspaceId}\0${operation}\0${code}`
    const lastEmittedAt = this.healthEventTimes.get(eventKey)
    if (
      lastEmittedAt !== undefined
      && occurredAt - lastEmittedAt < this.healthEventIntervalMs
    ) return
    this.healthEventTimes.set(eventKey, occurredAt)
    try {
      this.onHealthEvent?.({ workspaceId, ...lastIssue })
    } catch {
      // Health observers must never disrupt persistence.
    }
  }

  private recordHealthSuccess(workspaceId: string, operation: ActivityHealthOperation): void {
    const current = this.health.get(workspaceId)
    if (current?.lastIssue?.operation !== operation) return
    this.health.set(workspaceId, { available: true, status: 'healthy' })
  }

  private touch(state: StoreState): void {
    state.lastAccess = ++this.accessSequence
  }

  private scheduleSave(state: StoreState, delayMs = this.saveDebounceMs): void {
    if (state.saveTimer !== null || state.persistedGeneration >= state.generation) return
    state.saveTimer = this.scheduler.set(() => {
      state.saveTimer = null
      void this.persistState(state)
    }, delayMs)
  }

  private markDirty(state: StoreState): void {
    state.generation += 1
    this.scheduleSave(state)
  }

  private persistState(state: StoreState): Promise<void> {
    if (state.persistPromise) return state.persistPromise
    const task = (async () => {
      while (state.persistedGeneration < state.generation) {
        const generation = state.generation
        const snapshot = cloneRecords(state.records)
        await this.persistence.save(state.workspaceId, snapshot)
        state.persistedGeneration = Math.max(state.persistedGeneration, generation)
        state.saveFailureCount = 0
        this.recordHealthSuccess(state.workspaceId, 'save')
      }
    })()
    state.persistPromise = task
    void task.then(
      () => {
        if (state.persistPromise === task) state.persistPromise = null
        state.lastSaveError = null
        if (state.persistedGeneration < state.generation) this.scheduleSave(state, 1)
        this.queueEviction()
      },
      error => {
        if (state.persistPromise === task) state.persistPromise = null
        state.lastSaveError = error
        state.saveFailureCount += 1
        this.recordHealthFailure(state.workspaceId, 'save', error)
        if (this.stores.get(state.workspaceId) === state) {
          const retryMs = Math.min(
            this.maxSaveRetryMs,
            this.saveRetryMs * (2 ** Math.min(state.saveFailureCount - 1, 20)),
          )
          this.scheduleSave(state, retryMs)
        }
      },
    )
    return task
  }

  private async flushState(state: StoreState): Promise<void> {
    if (state.saveTimer !== null) {
      this.scheduler.clear(state.saveTimer)
      state.saveTimer = null
    }
    while (state.persistedGeneration < state.generation) {
      await this.persistState(state)
    }
  }

  private async loadState(workspaceId: string): Promise<StoreState> {
    const existing = this.stores.get(workspaceId)
    if (existing) return existing

    const activeLoad = this.loads.get(workspaceId)
    if (activeLoad) return activeLoad

    const load = (async () => {
      await this.reserveLoad(workspaceId)
      try {
        const result = await this.persistence.load(workspaceId)
        this.recordHealthSuccess(workspaceId, 'load')
        const raced = this.stores.get(workspaceId)
        if (raced) return raced
        const needsRewrite = result.needsRewrite
        const recordBytes = result.records.map(this.measureRecordBytes)
        const state: StoreState = {
          workspaceId,
          records: cloneRecords(result.records),
          recordBytes,
          documentBytes: activityDocumentByteLengthFromRecordBytes(recordBytes),
          generation: needsRewrite ? 1 : 0,
          persistedGeneration: 0,
          saveTimer: null,
          persistPromise: null,
          lastSaveError: null,
          saveFailureCount: 0,
          lastAccess: 0,
          activeUsers: 0,
        }
        this.stores.set(workspaceId, state)
        if (needsRewrite) this.scheduleSave(state)
        return state
      } catch (error) {
        this.recordHealthFailure(workspaceId, 'load', error)
        throw error
      } finally {
        this.admittedLoads.delete(workspaceId)
      }
    })()
    this.loads.set(workspaceId, load)
    void load.finally(() => {
      if (this.loads.get(workspaceId) === load) this.loads.delete(workspaceId)
    }).catch(() => {})
    return load
  }

  private reserveLoad(workspaceId: string): Promise<void> {
    if (this.stores.size + this.admittedLoads.size < this.maxLoadedWorkspaces) {
      this.admittedLoads.add(workspaceId)
      return Promise.resolve()
    }
    if (this.pendingAdmissionWorkspace !== null) {
      return Promise.reject(new ActivityStoreCapacityError())
    }
    this.pendingAdmissionWorkspace = workspaceId
    return this.evictOne().then(evicted => {
      if (!evicted && this.stores.size + this.admittedLoads.size >= this.maxLoadedWorkspaces) {
        throw new ActivityStoreCapacityError()
      }
      this.admittedLoads.add(workspaceId)
    }).finally(() => {
      if (this.pendingAdmissionWorkspace === workspaceId) {
        this.pendingAdmissionWorkspace = null
      }
    })
  }

  private async acquire(workspaceIdValue: unknown): Promise<StoreState> {
    const workspaceId = validateActivityWorkspaceId(workspaceIdValue)
    this.pendingAcquires.set(workspaceId, (this.pendingAcquires.get(workspaceId) ?? 0) + 1)
    try {
      const state = await this.loadState(workspaceId)
      state.activeUsers += 1
      this.touch(state)
      return state
    } finally {
      const remaining = (this.pendingAcquires.get(workspaceId) ?? 1) - 1
      if (remaining === 0) this.pendingAcquires.delete(workspaceId)
      else this.pendingAcquires.set(workspaceId, remaining)
    }
  }

  private release(state: StoreState): void {
    state.activeUsers = Math.max(0, state.activeUsers - 1)
    this.queueEviction()
  }

  private async withStore<T>(
    workspaceId: unknown,
    operation: (state: StoreState) => T | Promise<T>,
  ): Promise<T> {
    if (this.closing) throw new ActivityStoreClosedError()
    this.activeOperations += 1
    let state: StoreState | null = null
    try {
      state = await this.acquire(workspaceId)
      return await operation(state)
    } finally {
      if (state) this.release(state)
      this.activeOperations -= 1
      if (this.activeOperations === 0) {
        for (const resolve of this.operationWaiters.splice(0)) resolve()
      }
    }
  }

  private waitForActiveOperations(): Promise<void> {
    if (this.activeOperations === 0) return Promise.resolve()
    return new Promise(resolve => this.operationWaiters.push(resolve))
  }

  private queueEviction(): void {
    const task = this.evictionTail.then(() => this.evictToLimit())
    this.evictionTail = task.catch(() => {})
  }

  private async evictToLimit(): Promise<void> {
    while (this.stores.size > this.maxLoadedWorkspaces) {
      if (!(await this.evictOne())) return
    }
  }

  private async evictOne(): Promise<boolean> {
    const candidates = [...this.stores.values()]
        .filter(state => (
          state.activeUsers === 0
          && (this.pendingAcquires.get(state.workspaceId) ?? 0) === 0
        ))
        .sort((left, right) => left.lastAccess - right.lastAccess)
    for (const candidate of candidates) {
      try {
        await this.flushState(candidate)
      } catch {
        continue
      }
      if (
        candidate.activeUsers !== 0
        || (this.pendingAcquires.get(candidate.workspaceId) ?? 0) !== 0
        || candidate.persistPromise
        || candidate.persistedGeneration < candidate.generation
        || this.stores.get(candidate.workspaceId) !== candidate
      ) {
        continue
      }
      this.stores.delete(candidate.workspaceId)
      return true
    }
    return false
  }

  private assertCandidateFits(bytes: number): void {
    if (bytes > this.maxFileBytes) {
      throw new Error(`Activity store exceeds ${this.maxFileBytes} bytes`)
    }
  }

  private bytesForCappedRecords(
    records: ActivityRecord[],
    byteByRecord: Map<ActivityRecord, number>,
  ): { recordBytes: number[], documentBytes: number } {
    const recordBytes = records.map(record => {
      const bytes = byteByRecord.get(record)
      if (bytes === undefined) throw new Error('Activity byte accounting lost a record')
      return bytes
    })
    return {
      recordBytes,
      documentBytes: activityDocumentByteLengthFromRecordBytes(recordBytes),
    }
  }

  private boundResults(records: ActivityRecord[], limit: number): ActivityRecord[] {
    const result: ActivityRecord[] = []
    let bytes = 2
    for (const record of records) {
      if (result.length >= limit) break
      const clone = cloneRecord(record)
      const recordBytes = Buffer.byteLength(JSON.stringify(clone), 'utf8')
      const separatorBytes = result.length === 0 ? 0 : 1
      if (bytes + separatorBytes + recordBytes > this.maxQueryResponseBytes) break
      result.push(clone)
      bytes += separatorBytes + recordBytes
    }
    return result
  }

  private groupResults(records: ActivityRecord[]): Record<string, ActivityRecord[]> {
    const groups = new Map<string, ActivityRecord[]>()
    let bytes = 2
    let count = 0
    for (const record of records) {
      if (count >= MAX_ACTIVITY_QUERY_LIMIT) break
      const clone = cloneRecord(record)
      const key = clone.agent ?? `tile:${clone.tileId}`
      const group = groups.get(key)
      const recordBytes = Buffer.byteLength(JSON.stringify(clone), 'utf8')
      const addedBytes = group
        ? 1 + recordBytes
        : (groups.size === 0 ? 0 : 1)
          + Buffer.byteLength(JSON.stringify(key), 'utf8')
          + 3
          + recordBytes
      if (bytes + addedBytes > this.maxQueryResponseBytes) break
      if (group) group.push(clone)
      else groups.set(key, [clone])
      bytes += addedBytes
      count += 1
    }
    return Object.fromEntries(groups)
  }

  async upsert(workspaceIdValue: unknown, inputValue: unknown): Promise<ActivityRecord> {
    const workspaceId = validateActivityWorkspaceId(workspaceIdValue)
    const data = validateActivityUpsertInput(inputValue)
    return this.withStore(workspaceId, state => {
      const now = this.now()
      const index = data.id === undefined
        ? -1
        : state.records.findIndex(record => record.tileId === data.tileId && record.id === data.id)
      let record: ActivityRecord
      const candidate = [...state.records]
      const candidateRecordBytes = [...state.recordBytes]
      let candidateDocumentBytes = state.documentBytes
      if (index >= 0) {
        const existing = state.records[index]
        const metadata = validateActivityMetadata(
          mergeMetadata(existing.metadata, data.metadata),
        )
        record = {
          ...existing,
          status: data.status ?? existing.status,
          title: data.title,
          ...(data.detail === undefined ? { detail: existing.detail } : { detail: data.detail }),
          ...(metadata === undefined ? {} : { metadata }),
          ...(data.agent === undefined ? { agent: existing.agent } : { agent: data.agent }),
          updatedAt: now,
        }
        candidate[index] = record
        const measuredBytes = this.measureRecordBytes(record)
        candidateDocumentBytes += measuredBytes - candidateRecordBytes[index]
        candidateRecordBytes[index] = measuredBytes
      } else {
        record = {
          id: data.id ?? validateActivityId(this.createId()),
          tileId: data.tileId,
          workspaceId,
          type: data.type,
          status: data.status ?? 'pending',
          title: data.title,
          ...(data.detail === undefined ? {} : { detail: data.detail }),
          ...(data.metadata === undefined ? {} : { metadata: data.metadata }),
          ...(data.agent === undefined ? {} : { agent: data.agent }),
          createdAt: now,
          updatedAt: now,
        }
        candidate.push(record)
        const measuredBytes = this.measureRecordBytes(record)
        candidateDocumentBytes += measuredBytes + (state.records.length === 0 ? 0 : 1)
        candidateRecordBytes.push(measuredBytes)
      }

      let capped = capActivityRecords(candidate, now)
      if (!capped.includes(record)) {
        capped = [...capped.slice(0, -1), record]
      }
      const byteByRecord = new Map(
        candidate.map((candidateRecord, candidateIndex) => (
          [candidateRecord, candidateRecordBytes[candidateIndex]] as const
        )),
      )
      const accounting = capped === candidate
        ? {
            recordBytes: candidateRecordBytes,
            documentBytes: candidateDocumentBytes,
          }
        : this.bytesForCappedRecords(capped, byteByRecord)
      this.assertCandidateFits(accounting.documentBytes)
      state.records = capped
      state.recordBytes = accounting.recordBytes
      state.documentBytes = accounting.documentBytes
      this.markDirty(state)
      return cloneRecord(record)
    })
  }

  async query(queryValue: unknown): Promise<ActivityRecord[]> {
    const query: ActivityQuery = validateActivityQuery(queryValue)
    return this.withStore(query.workspaceId, state => {
      let records = state.records.filter(record => (
        (query.tileId === undefined || record.tileId === query.tileId)
        && (query.type === undefined || record.type === query.type)
        && (query.status === undefined || record.status === query.status)
        && (query.agent === undefined || record.agent === query.agent)
      ))
      records = [...records].sort((left, right) => right.updatedAt - left.updatedAt)
      return this.boundResults(records, query.limit ?? MAX_ACTIVITY_QUERY_LIMIT)
    })
  }

  async byTile(workspaceId: unknown, tileIdValue: unknown): Promise<ActivityRecord[]> {
    const tileId = validateActivityTileId(tileIdValue)
    return this.query({ workspaceId, tileId })
  }

  async delete(workspaceId: unknown, tileIdValue: unknown, idValue: unknown): Promise<boolean> {
    const tileId = validateActivityTileId(tileIdValue)
    const id = validateActivityId(idValue)
    return this.withStore(workspaceId, state => {
      const index = state.records.findIndex(record => record.tileId === tileId && record.id === id)
      if (index === -1) return false
      const candidate = [...state.records.slice(0, index), ...state.records.slice(index + 1)]
      const candidateRecordBytes = [
        ...state.recordBytes.slice(0, index),
        ...state.recordBytes.slice(index + 1),
      ]
      const documentBytes = (
        state.documentBytes
        - state.recordBytes[index]
        - (state.records.length === 1 ? 0 : 1)
      )
      this.assertCandidateFits(documentBytes)
      state.records = candidate
      state.recordBytes = candidateRecordBytes
      state.documentBytes = documentBytes
      this.markDirty(state)
      return true
    })
  }

  async clearTile(workspaceId: unknown, tileIdValue: unknown): Promise<number> {
    const tileId = validateActivityTileId(tileIdValue)
    return this.withStore(workspaceId, state => {
      const candidate: ActivityRecord[] = []
      const candidateRecordBytes: number[] = []
      for (let index = 0; index < state.records.length; index += 1) {
        if (state.records[index].tileId === tileId) continue
        candidate.push(state.records[index])
        candidateRecordBytes.push(state.recordBytes[index])
      }
      const removed = state.records.length - candidate.length
      if (removed > 0) {
        const documentBytes = activityDocumentByteLengthFromRecordBytes(candidateRecordBytes)
        this.assertCandidateFits(documentBytes)
        state.records = candidate
        state.recordBytes = candidateRecordBytes
        state.documentBytes = documentBytes
        this.markDirty(state)
      }
      return removed
    })
  }

  async byAgent(workspaceIdValue: unknown): Promise<Record<string, ActivityRecord[]>> {
    const workspaceId = validateActivityWorkspaceId(workspaceIdValue)
    return this.withStore(workspaceId, state => {
      const sorted = [...state.records].sort((left, right) => right.updatedAt - left.updatedAt)
      return this.groupResults(sorted)
    })
  }

  async flushAll(): Promise<void> {
    this.closing = true
    await this.waitForActiveOperations()
    await Promise.allSettled([...this.loads.values()])
    const results = await Promise.allSettled(
      [...this.stores.values()].map(state => this.flushState(state)),
    )
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to flush activity stores')
    this.queueEviction()
    await this.evictionTail
  }

  async settleMaintenance(): Promise<void> {
    await this.evictionTail
  }

  getStats(): ActivityStoreStats {
    return {
      loadedWorkspaceIds: [...this.stores.keys()],
      loadingWorkspaceIds: [...this.loads.keys()],
      dirtyWorkspaceIds: [...this.stores.values()]
        .filter(state => state.persistedGeneration < state.generation)
        .map(state => state.workspaceId),
    }
  }

  getHealth(workspaceIdValue: unknown): ActivityHealthSnapshot {
    const workspaceId = validateActivityWorkspaceId(workspaceIdValue)
    const current = this.health.get(workspaceId)
    return current
      ? {
          ...current,
          ...(current.lastIssue ? { lastIssue: { ...current.lastIssue } } : {}),
        }
      : { available: true, status: 'healthy' }
  }
}

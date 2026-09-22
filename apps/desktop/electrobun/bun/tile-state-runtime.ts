import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TileContextEntry } from '../../src/shared/types.ts'

type TileStateRecord = Record<string, unknown>

function safeSegment(value: string, label: string): string {
  const segment = String(value ?? '').trim()
  if (
    !segment
    || segment === '.'
    || segment === '..'
    || segment.includes('/')
    || segment.includes('\\')
    || segment.includes('\0')
  ) throw new Error(`Invalid ${label}`)
  return segment
}

function isRecord(value: unknown): value is TileStateRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function mergeState(existing: unknown, patch: unknown): unknown {
  if (!isRecord(patch)) return patch
  if (!isRecord(existing)) return { ...patch }
  const merged: TileStateRecord = { ...existing }
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    merged[key] = isRecord(value) && isRecord(merged[key])
      ? mergeState(merged[key], value)
      : value
  }
  return merged
}

export class ElectrobunTileStateRuntime {
  private readonly lanes = new Map<string, Promise<void>>()
  private readonly workspacesDir: string

  constructor(workspacesDir: string) {
    this.workspacesDir = workspacesDir
  }

  async load(workspaceId: string, tileId: string): Promise<unknown | null> {
    const file = this.path(workspaceId, tileId)
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch {
      return null
    }
  }

  async save(workspaceId: string, tileId: string, patch: unknown): Promise<void> {
    await this.update(workspaceId, tileId, existing => mergeState(existing, patch))
  }

  async delete(workspaceId: string, tileId: string): Promise<void> {
    const file = this.path(workspaceId, tileId)
    await this.run(workspaceId, tileId, async () => {
      await unlink(file).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    })
  }

  async loadContext(workspaceId: string, tileId: string): Promise<Record<string, TileContextEntry>> {
    const state = await this.load(workspaceId, tileId)
    return isRecord(state) && isRecord(state._context)
      ? state._context as Record<string, TileContextEntry>
      : {}
  }

  async saveContext(
    workspaceId: string,
    tileId: string,
    context: Record<string, TileContextEntry>,
  ): Promise<void> {
    await this.update(workspaceId, tileId, existing => ({
      ...(isRecord(existing) ? existing : {}),
      _context: context,
    }))
  }

  private path(workspaceId: string, tileId: string): string {
    return join(
      this.workspacesDir,
      safeSegment(workspaceId, 'workspaceId'),
      'tiles',
      `${safeSegment(tileId, 'tileId')}.json`,
    )
  }

  private async update(
    workspaceId: string,
    tileId: string,
    update: (existing: unknown | null) => unknown | Promise<unknown>,
  ): Promise<void> {
    const file = this.path(workspaceId, tileId)
    await this.run(workspaceId, tileId, async () => {
      const next = await update(await this.load(workspaceId, tileId))
      const directory = dirname(file)
      const temporary = join(directory, `.${safeSegment(tileId, 'tileId')}.${randomUUID()}.tmp`)
      await mkdir(directory, { recursive: true })
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2))
        await rename(temporary, file)
      } catch (error) {
        await unlink(temporary).catch(() => {})
        throw error
      }
    })
  }

  private async run(
    workspaceId: string,
    tileId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const scope = JSON.stringify([
      safeSegment(workspaceId, 'workspaceId'),
      safeSegment(tileId, 'tileId'),
    ])
    const previous = this.lanes.get(scope) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    const lane = current.then(() => {}, () => {})
    this.lanes.set(scope, lane)
    try {
      await current
    } finally {
      if (this.lanes.get(scope) === lane) this.lanes.delete(scope)
    }
  }
}

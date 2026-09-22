import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mutateArchivedSessionIds,
  readArchivedSessionIds,
} from '../src/main/storage/sessionArchives.ts'

describe('mutateArchivedSessionIds', () => {
  let dir: string
  let archivePath: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'session-archives-'))
    archivePath = join(dir, 'session-archives.json')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test('persists a single archive entry', async () => {
    const changed = await mutateArchivedSessionIds([archivePath], archivePath, ids => {
      ids.add('sid:claude:abc')
      return true
    })
    assert.equal(changed, true)
    const archived = await readArchivedSessionIds([archivePath])
    assert.deepEqual(Array.from(archived), ['sid:claude:abc'])
  })

  test('concurrent mutations of the same file do not lose updates', async () => {
    // Regression: bulk "Archive chats" fires one IPC call per session; each
    // handler used to read-modify-write session-archives.json concurrently,
    // so the last writer won and all but one archive flag silently vanished.
    const sessionIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    await Promise.all(sessionIds.map(id =>
      mutateArchivedSessionIds([archivePath], archivePath, ids => {
        ids.add(`sid:claude:${id}`)
        return true
      }),
    ))
    const archived = await readArchivedSessionIds([archivePath])
    assert.deepEqual(
      Array.from(archived).sort(),
      sessionIds.map(id => `sid:claude:${id}`).sort(),
    )
  })

  test('returns false and skips the write when the mutator reports no change', async () => {
    await mutateArchivedSessionIds([archivePath], archivePath, ids => {
      ids.add('sid:claude:abc')
      return true
    })
    const before = await fs.stat(archivePath)
    const changed = await mutateArchivedSessionIds([archivePath], archivePath, ids =>
      ids.has('sid:claude:missing'))
    assert.equal(changed, false)
    const after = await fs.stat(archivePath)
    assert.equal(before.mtimeMs, after.mtimeMs)
  })

  test('merges entries from secondary read paths before mutating', async () => {
    const legacyPath = join(dir, 'legacy-archives.json')
    await mutateArchivedSessionIds([legacyPath], legacyPath, ids => {
      ids.add('sid:claude:legacy')
      return true
    })
    await mutateArchivedSessionIds([archivePath, legacyPath], archivePath, ids => {
      ids.add('sid:claude:new')
      return true
    })
    const archived = await readArchivedSessionIds([archivePath])
    assert.deepEqual(
      Array.from(archived).sort(),
      ['sid:claude:legacy', 'sid:claude:new'],
    )
  })

  test('queue recovers after a mutator throws', async () => {
    await assert.rejects(mutateArchivedSessionIds([archivePath], archivePath, () => {
      throw new Error('boom')
    }))
    const changed = await mutateArchivedSessionIds([archivePath], archivePath, ids => {
      ids.add('sid:claude:after-error')
      return true
    })
    assert.equal(changed, true)
    const archived = await readArchivedSessionIds([archivePath])
    assert.deepEqual(Array.from(archived), ['sid:claude:after-error'])
  })
})

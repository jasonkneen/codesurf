import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeArchivedSessionIds,
  readArchivedSessionIds,
  writeArchivedSessionIds,
} from '../../src/main/storage/sessionArchives.ts'

test('session archive store normalizes ids and removes junk', () => {
  assert.deepEqual(
    normalizeArchivedSessionIds([' thread-a ', '', null, 'thread-b', 'thread-a', 42]),
    ['thread-a', 'thread-b'],
  )
})

test('session archive store writes and reads round-trip state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codesurf-session-archives-'))
  const archivePath = join(dir, 'session-archives.json')

  try {
    await writeArchivedSessionIds(archivePath, ['thread-a', 'thread-b', 'thread-a'])
    const raw = JSON.parse(await readFile(archivePath, 'utf8'))
    assert.deepEqual(raw, {
      version: 1,
      archivedSessionIds: ['thread-a', 'thread-b'],
    })

    const archived = await readArchivedSessionIds([archivePath])
    assert.deepEqual([...archived], ['thread-a', 'thread-b'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('session archive store unions ids across workspace storage aliases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codesurf-session-archives-aliases-'))
  const primaryPath = join(dir, 'primary.json')
  const aliasPath = join(dir, 'alias.json')

  try {
    await writeArchivedSessionIds(primaryPath, ['thread-a'])
    await writeArchivedSessionIds(aliasPath, ['thread-b'])
    const archived = await readArchivedSessionIds([primaryPath, aliasPath])
    assert.deepEqual([...archived], ['thread-a', 'thread-b'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

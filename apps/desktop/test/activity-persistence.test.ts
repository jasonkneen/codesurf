import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ActivityRecord } from '../src/shared/activity-types.ts'
import {
  ACTIVITY_QUARANTINE_PREFIX,
  ActivityPersistenceError,
  activityModeNeedsRepair,
  activityStorePath,
  createFileActivityPersistence,
  serializeActivityDocument,
} from '../src/main/activity-persistence.ts'
import { ACTIVITY_DOCUMENT_VERSION } from '../src/main/activity-validation.ts'
import { ActivityStore } from '../src/main/activity-store-core.ts'
import { MAX_ACTIVITY_RECORDS } from '../src/main/activity-cap.ts'

const NOW = Date.now()

function record(workspaceId = 'workspace-1'): ActivityRecord {
  return {
    id: 'activity-1',
    tileId: 'tile-1',
    workspaceId,
    type: 'task',
    status: 'running',
    title: 'Review',
    createdAt: NOW - 100,
    updatedAt: NOW,
  }
}

async function fixture(): Promise<{ homeDir: string, cleanup: () => Promise<void> }> {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-activity-storage-'))
  return {
    homeDir,
    cleanup: () => rm(homeDir, { recursive: true, force: true }),
  }
}

describe('file activity persistence', () => {
  test('rejects traversal before resolving an activity path', () => {
    assert.throws(() => activityStorePath('/tmp/codesurf-test', '../escape'))
    assert.throws(() => activityStorePath('/tmp/codesurf-test', 'nested/workspace'))
  })

  test('returns an empty store only when the file does not exist', async () => {
    const { homeDir, cleanup } = await fixture()
    try {
      const persistence = createFileActivityPersistence({ homeDir })
      assert.deepEqual(await persistence.load('workspace-1'), {
        records: [],
        needsRewrite: false,
      })

      const filePath = activityStorePath(homeDir, 'workspace-1')
      await mkdir(filePath, { recursive: true })
      await assert.rejects(
        persistence.load('workspace-1'),
        (error: unknown) => error instanceof ActivityPersistenceError && error.code === 'not_a_file',
      )
    } finally {
      await cleanup()
    }
  })

  test('loads legacy arrays but requires a rewrite', async () => {
    const { homeDir, cleanup } = await fixture()
    try {
      const filePath = activityStorePath(homeDir, 'workspace-1')
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, JSON.stringify([record()]))
      const persistence = createFileActivityPersistence({ homeDir })
      assert.deepEqual(await persistence.load('workspace-1'), {
        records: [record()],
        needsRewrite: true,
      })
    } finally {
      await cleanup()
    }
  })

  test('trims a compact legacy document to a canonical document that fits the exact read cap', async () => {
    const { homeDir, cleanup } = await fixture()
    try {
      const records = Array.from({ length: 4 }, (_, index) => ({
        ...record('workspace-1'),
        id: `activity-${index}`,
        detail: 'x'.repeat(300),
        createdAt: NOW - index,
        updatedAt: NOW - index,
      }))
      const raw = JSON.stringify([...records].reverse())
      const maxFileBytes = Buffer.byteLength(raw, 'utf8')
      assert.ok(Buffer.byteLength(serializeActivityDocument('workspace-1', records), 'utf8') > maxFileBytes)

      const filePath = activityStorePath(homeDir, 'workspace-1')
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, raw)
      const persistence = createFileActivityPersistence({ homeDir, maxFileBytes })
      const loaded = await persistence.load('workspace-1')

      assert.equal(loaded.needsRewrite, true)
      assert.deepEqual(loaded.records.map(item => item.id), [
        'activity-0',
        'activity-1',
        'activity-2',
      ])
      const store = new ActivityStore({ persistence, maxFileBytes })
      await store.query({ workspaceId: 'workspace-1' })
      await store.flushAll()
      assert.ok((await stat(filePath)).size <= maxFileBytes)
      assert.equal(JSON.parse(await readFile(filePath, 'utf8')).version, ACTIVITY_DOCUMENT_VERSION)
    } finally {
      await cleanup()
    }
  })

  test('writes a versioned document atomically with restrictive permissions', async () => {
    const { homeDir, cleanup } = await fixture()
    try {
      const persistence = createFileActivityPersistence({ homeDir })
      await persistence.save('workspace-1', [record()])

      const filePath = activityStorePath(homeDir, 'workspace-1')
      const raw = await readFile(filePath, 'utf8')
      assert.deepEqual(JSON.parse(raw), {
        version: ACTIVITY_DOCUMENT_VERSION,
        records: [record()],
      })
      assert.equal((await stat(filePath)).mode & 0o777, 0o600)
      assert.equal((await stat(dirname(filePath))).mode & 0o777, 0o700)
      assert.deepEqual(
        (await readdir(dirname(filePath))).filter(name => name.endsWith('.tmp')),
        [],
      )

      await chmod(filePath, 0o666)
      await persistence.save('workspace-1', [record()])
      assert.equal((await stat(filePath)).mode & 0o777, 0o600)
    } finally {
      await cleanup()
    }
  })

  test('repairs exposed permissions on current and legacy stores through the normal writer', async () => {
    const cases = [
      {
        name: 'current',
        document: {
          version: ACTIVITY_DOCUMENT_VERSION,
          records: [record('current')],
        },
      },
      {
        name: 'legacy',
        document: [record('legacy')],
      },
    ]

    for (const testCase of cases) {
      const { homeDir, cleanup } = await fixture()
      try {
        const filePath = activityStorePath(homeDir, testCase.name)
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, JSON.stringify(testCase.document))
        await chmod(filePath, 0o644)

        const persistence = createFileActivityPersistence({ homeDir })
        const store = new ActivityStore({ persistence })
        assert.equal((await store.query({ workspaceId: testCase.name })).length, 1)
        await store.flushAll()

        assert.equal((await stat(filePath)).mode & 0o777, 0o600)
        const repaired = JSON.parse(await readFile(filePath, 'utf8')) as {
          version: number
          records: ActivityRecord[]
        }
        assert.equal(repaired.version, ACTIVITY_DOCUMENT_VERSION)
        assert.equal(repaired.records[0]?.workspaceId, testCase.name)
      } finally {
        await cleanup()
      }
    }
  })

  test('secures future and oversized files synchronously while preserving their bytes', async () => {
    const cases: Array<{ name: string, raw: string, maxFileBytes?: number }> = [
      {
        name: 'future',
        raw: JSON.stringify({ version: ACTIVITY_DOCUMENT_VERSION + 1, records: [] }),
      },
      { name: 'oversized', raw: 'x'.repeat(128), maxFileBytes: 64 },
    ]

    for (const testCase of cases) {
      const { homeDir, cleanup } = await fixture()
      try {
        const filePath = activityStorePath(homeDir, testCase.name)
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, testCase.raw)
        await chmod(filePath, 0o644)
        const persistence = createFileActivityPersistence({
          homeDir,
          ...(testCase.maxFileBytes === undefined ? {} : { maxFileBytes: testCase.maxFileBytes }),
        })
        await assert.rejects(persistence.load(testCase.name), ActivityPersistenceError)
        assert.equal(await readFile(filePath, 'utf8'), testCase.raw)
        assert.equal((await stat(filePath)).mode & 0o777, 0o600)
        assert.deepEqual(await readdir(dirname(filePath)), ['activity.json'])
      } finally {
        await cleanup()
      }
    }
  })

  test('defines permission repair as a POSIX-only operation', () => {
    assert.equal(activityModeNeedsRepair(0o100644n, 'darwin'), true)
    assert.equal(activityModeNeedsRepair(0o100600n, 'linux'), false)
    assert.equal(activityModeNeedsRepair(0o100644n, 'win32'), false)
  })

  test('quarantines corrupt bytes exactly and starts a rewriteable empty store', async () => {
    const { homeDir, cleanup } = await fixture()
    try {
      const filePath = activityStorePath(homeDir, 'workspace-1')
      const raw = Buffer.from([0x7b, 0xff, 0x00, 0x7d])
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, raw)
      const persistence = createFileActivityPersistence({ homeDir })

      assert.deepEqual(await persistence.load('workspace-1'), {
        records: [],
        needsRewrite: true,
      })
      assert.deepEqual(await readFile(filePath), raw)
      const quarantine = (await readdir(dirname(filePath)))
        .find(name => name.startsWith(ACTIVITY_QUARANTINE_PREFIX))
      assert.ok(quarantine)
      assert.deepEqual(await readFile(join(dirname(filePath), quarantine)), raw)
      assert.equal((await stat(join(dirname(filePath), quarantine))).mode & 0o777, 0o600)
    } finally {
      await cleanup()
    }
  })

  test('fatally rejects invalid UTF-8 instead of parsing replacement characters', async () => {
    const { homeDir, cleanup } = await fixture()
    try {
      const filePath = activityStorePath(homeDir, 'workspace-1')
      const raw = Buffer.concat([
        Buffer.from('{"version":1,"records":[],"unknown":"'),
        Buffer.from([0xff]),
        Buffer.from('"}'),
      ])
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, raw)
      const persistence = createFileActivityPersistence({ homeDir })

      assert.deepEqual(await persistence.load('workspace-1'), {
        records: [],
        needsRewrite: true,
      })
      const quarantine = (await readdir(dirname(filePath)))
        .find(name => name.startsWith(ACTIVITY_QUARANTINE_PREFIX))
      assert.ok(quarantine)
      assert.deepEqual(await readFile(join(dirname(filePath), quarantine)), raw)
    } finally {
      await cleanup()
    }
  })

  test('deduplicates quarantine on restart and enforces count and aggregate-byte retention', async () => {
    const { homeDir, cleanup } = await fixture()
    try {
      const filePath = activityStorePath(homeDir, 'workspace-1')
      const raws = [1, 2, 3].map(marker => Buffer.from(`{broken-${marker}-${'x'.repeat(24)}`))
      const persistence = createFileActivityPersistence({
        homeDir,
        maxQuarantineFiles: 2,
        maxQuarantineBytes: raws[0].byteLength * 2,
      })
      await mkdir(dirname(filePath), { recursive: true })

      for (const raw of raws) {
        await writeFile(filePath, raw)
        assert.equal((await persistence.load('workspace-1')).needsRewrite, true)
      }
      const retained = (await readdir(dirname(filePath)))
        .filter(name => name.startsWith(ACTIVITY_QUARANTINE_PREFIX))
      assert.equal(retained.length, 2)
      const retainedBytes = await Promise.all(
        retained.map(name => stat(join(dirname(filePath), name)).then(info => info.size)),
      )
      assert.ok(retainedBytes.reduce((total, size) => total + size, 0) <= raws[0].byteLength * 2)

      await writeFile(filePath, raws[2])
      await persistence.load('workspace-1')
      assert.deepEqual(
        (await readdir(dirname(filePath)))
          .filter(name => name.startsWith(ACTIVITY_QUARANTINE_PREFIX))
          .sort(),
        retained.sort(),
      )
    } finally {
      await cleanup()
    }
  })

  test('does not duplicate quarantine when a rewrite fails and the source is loaded again', async () => {
    const { homeDir, cleanup } = await fixture()
    try {
      const filePath = activityStorePath(homeDir, 'workspace-1')
      const raw = Buffer.from('{broken')
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, raw)
      const persistence = createFileActivityPersistence({
        homeDir,
        writeHooks: {
          beforeRename(path) {
            if (path === filePath) throw new Error('injected pre-commit failure')
          },
        },
      })
      const store = new ActivityStore({ persistence })
      await store.query({ workspaceId: 'workspace-1' })
      await assert.rejects(store.flushAll())
      assert.deepEqual(await readFile(filePath), raw)

      const restarted = createFileActivityPersistence({ homeDir })
      await restarted.load('workspace-1')
      assert.equal(
        (await readdir(dirname(filePath)))
          .filter(name => name.startsWith(ACTIVITY_QUARANTINE_PREFIX))
          .length,
        1,
      )
    } finally {
      await cleanup()
    }
  })

  test('caps oversized legacy arrays through bounded migration without quarantine', async () => {
    const { homeDir, cleanup } = await fixture()
    try {
      const filePath = activityStorePath(homeDir, 'workspace-1')
      const records = Array.from({ length: MAX_ACTIVITY_RECORDS + 25 }, (_, index) => record())
        .map((item, index) => ({
          ...item,
          id: `legacy-${index}`,
          createdAt: NOW - 20_000,
          updatedAt: NOW - index,
        }))
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, JSON.stringify(records))
      const persistence = createFileActivityPersistence({ homeDir })

      const loaded = await persistence.load('workspace-1')
      assert.equal(loaded.records.length, MAX_ACTIVITY_RECORDS)
      assert.equal(loaded.records[0].id, 'legacy-0')
      assert.equal(loaded.records.some(item => item.id === `legacy-${MAX_ACTIVITY_RECORDS + 24}`), false)
      assert.equal(loaded.needsRewrite, true)
      assert.deepEqual(await readdir(dirname(filePath)), ['activity.json'])
    } finally {
      await cleanup()
    }
  })

  test('quarantines mixed documents, salvages valid rows, then persists subsequent activity', async () => {
    const { homeDir, cleanup } = await fixture()
    try {
      const filePath = activityStorePath(homeDir, 'workspace-1')
      const mixed = Buffer.from(JSON.stringify({
        version: ACTIVITY_DOCUMENT_VERSION,
        records: [
          record(),
          { ...record(), id: 42 },
          { ...record(), id: 'activity-2', tileId: 'tile-2' },
        ],
      }))
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, mixed)
      const persistence = createFileActivityPersistence({ homeDir })
      const store = new ActivityStore({ persistence, now: () => NOW + 1 })

      assert.deepEqual(
        (await store.query({ workspaceId: 'workspace-1' })).map(item => item.id).sort(),
        ['activity-1', 'activity-2'],
      )
      await store.upsert('workspace-1', {
        id: 'activity-3',
        tileId: 'tile-3',
        type: 'task',
        title: 'Recovered work',
      })
      await store.flushAll()

      const names = await readdir(dirname(filePath))
      const quarantine = names.find(name => name.startsWith(ACTIVITY_QUARANTINE_PREFIX))
      assert.ok(quarantine)
      assert.deepEqual(await readFile(join(dirname(filePath), quarantine)), mixed)
      const current = JSON.parse(await readFile(filePath, 'utf8')) as {
        version: number
        records: ActivityRecord[]
      }
      assert.equal(current.version, ACTIVITY_DOCUMENT_VERSION)
      assert.deepEqual(current.records.map(item => item.id).sort(), [
        'activity-1',
        'activity-2',
        'activity-3',
      ])
    } finally {
      await cleanup()
    }
  })

  test('rejects records from another workspace before touching the destination', async () => {
    const { homeDir, cleanup } = await fixture()
    try {
      const persistence = createFileActivityPersistence({ homeDir })
      await assert.rejects(persistence.save('workspace-1', [record('workspace-2')]))
      await assert.rejects(stat(activityStorePath(homeDir, 'workspace-1')), { code: 'ENOENT' })
    } finally {
      await cleanup()
    }
  })

  test('rejects a symbolic-link activity file without reading its target', async () => {
    const { homeDir, cleanup } = await fixture()
    const externalDir = await mkdtemp(join(tmpdir(), 'codesurf-activity-external-'))
    try {
      const filePath = activityStorePath(homeDir, 'workspace-1')
      const externalPath = join(externalDir, 'outside.json')
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(externalPath, JSON.stringify({
        version: ACTIVITY_DOCUMENT_VERSION,
        records: [record()],
      }))
      await symlink(externalPath, filePath)

      const persistence = createFileActivityPersistence({ homeDir })
      await assert.rejects(
        persistence.load('workspace-1'),
        (error: unknown) => error instanceof ActivityPersistenceError && error.code === 'unsafe_path',
      )
    } finally {
      await Promise.all([
        cleanup(),
        rm(externalDir, { recursive: true, force: true }),
      ])
    }
  })

  test('rejects a symbolic-link workspace directory', async () => {
    const { homeDir, cleanup } = await fixture()
    const externalDir = await mkdtemp(join(tmpdir(), 'codesurf-activity-external-workspace-'))
    try {
      const workspacesDir = join(homeDir, 'workspaces')
      await mkdir(workspacesDir, { recursive: true })
      await mkdir(join(externalDir, '.codesurf'), { recursive: true })
      await writeFile(join(externalDir, '.codesurf', 'activity.json'), JSON.stringify({
        version: ACTIVITY_DOCUMENT_VERSION,
        records: [record()],
      }))
      await symlink(externalDir, join(workspacesDir, 'workspace-1'))

      const persistence = createFileActivityPersistence({ homeDir })
      await assert.rejects(
        persistence.load('workspace-1'),
        (error: unknown) => error instanceof ActivityPersistenceError && error.code === 'unsafe_path',
      )
    } finally {
      await Promise.all([
        cleanup(),
        rm(externalDir, { recursive: true, force: true }),
      ])
    }
  })

  test('rejects deterministic replacement after opening a retained handle', async () => {
    const { homeDir, cleanup } = await fixture()
    try {
      const filePath = activityStorePath(homeDir, 'workspace-1')
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, JSON.stringify({
        version: ACTIVITY_DOCUMENT_VERSION,
        records: [record()],
      }))

      let replaced = false
      const persistence = createFileActivityPersistence({
        homeDir,
        readHooks: {
          async afterOpen(path) {
            const displaced = `${path}.displaced`
            await rename(path, displaced)
            await writeFile(path, JSON.stringify({
              version: ACTIVITY_DOCUMENT_VERSION,
              records: [],
            }))
            replaced = true
          },
        },
      })
      await assert.rejects(
        persistence.load('workspace-1'),
        (error: unknown) => error instanceof ActivityPersistenceError && error.code === 'path_changed',
      )
      assert.equal(replaced, true)
    } finally {
      await cleanup()
    }
  })

  test('wraps a deterministic realpath race in a sanitized persistence error', async () => {
    const { homeDir, cleanup } = await fixture()
    try {
      const filePath = activityStorePath(homeDir, 'workspace-1')
      const activityDir = dirname(filePath)
      await mkdir(activityDir, { recursive: true })
      await writeFile(filePath, JSON.stringify({
        version: ACTIVITY_DOCUMENT_VERSION,
        records: [record()],
      }))
      const persistence = createFileActivityPersistence({
        homeDir,
        readHooks: {
          async afterAncestorInspect() {
            await rename(activityDir, `${activityDir}.moved`)
          },
        },
      })
      await assert.rejects(
        persistence.load('workspace-1'),
        (error: unknown) => (
          error instanceof ActivityPersistenceError
          && error.code === 'path_changed'
          && !error.message.includes(homeDir)
        ),
      )
    } finally {
      await cleanup()
    }
  })

  test('reports post-rename and directory-sync failures as committed-but-uncertain', async () => {
    for (const failurePoint of ['afterRename', 'beforeDirectorySync'] as const) {
      const { homeDir, cleanup } = await fixture()
      try {
        const filePath = activityStorePath(homeDir, 'workspace-1')
        const persistence = createFileActivityPersistence({
          homeDir,
          writeHooks: {
            [failurePoint](path: string) {
              if (path === filePath) throw new Error(`injected ${failurePoint}`)
            },
          },
        })
        await assert.rejects(
          persistence.save('workspace-1', [record()]),
          (error: unknown) => (
            error instanceof ActivityPersistenceError
            && error.code === 'commit_uncertain'
          ),
        )
        assert.deepEqual(
          JSON.parse(await readFile(filePath, 'utf8')).records,
          [record()],
        )
        assert.deepEqual(
          (await readdir(dirname(filePath))).filter(name => name.endsWith('.tmp')),
          [],
        )
      } finally {
        await cleanup()
      }
    }
  })

  test('save rejects symbolic-link files and ancestors without changing external targets', async () => {
    const cases = ['file', 'workspace', 'activity-dir'] as const
    for (const kind of cases) {
      const { homeDir, cleanup } = await fixture()
      const externalDir = await mkdtemp(join(tmpdir(), 'codesurf-activity-write-external-'))
      try {
        const filePath = activityStorePath(homeDir, 'workspace-1')
        const externalPath = join(externalDir, 'outside.json')
        const original = 'external-content-must-survive'
        await writeFile(externalPath, original)

        if (kind === 'file') {
          await mkdir(dirname(filePath), { recursive: true })
          await symlink(externalPath, filePath)
        } else if (kind === 'workspace') {
          await mkdir(join(homeDir, 'workspaces'), { recursive: true })
          await symlink(externalDir, join(homeDir, 'workspaces', 'workspace-1'))
        } else {
          await mkdir(join(homeDir, 'workspaces', 'workspace-1'), { recursive: true })
          await symlink(externalDir, dirname(filePath))
        }

        const persistence = createFileActivityPersistence({ homeDir })
        await assert.rejects(
          persistence.save('workspace-1', [record()]),
          (error: unknown) => error instanceof ActivityPersistenceError && error.code === 'unsafe_path',
        )
        assert.equal(await readFile(externalPath, 'utf8'), original)
        assert.deepEqual(
          (await readdir(externalDir)).sort(),
          ['outside.json'],
        )
      } finally {
        await Promise.all([
          cleanup(),
          rm(externalDir, { recursive: true, force: true }),
        ])
      }
    }
  })
})

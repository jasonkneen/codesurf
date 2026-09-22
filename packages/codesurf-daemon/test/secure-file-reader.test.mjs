import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  fileIdentity,
  readVerifiedFile,
} from '../bin/secure-file-reader.mjs'

test('verified provider read rejects same-size mutation during the read', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-secure-read-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'image.png')
  await writeFile(path, Buffer.from('12345678'))
  const identity = fileIdentity(await stat(path))

  await assert.rejects(
    readVerifiedFile({
      path,
      identity,
      maxBytes: 32,
      beforeFinalStat: async () => {
        await writeFile(path, Buffer.from('ABCDEFGH'))
      },
    }),
    /changed during validation/i,
  )
})

test('verified provider read enforces the byte limit before allocation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-secure-read-limit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'image.png')
  await writeFile(path, Buffer.alloc(65, 1))
  const identity = fileIdentity(await stat(path))

  await assert.rejects(
    readVerifiedFile({ path, identity, maxBytes: 64 }),
    /exceeds the 64 byte limit/i,
  )
})

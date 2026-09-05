import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const migration = readFileSync(new URL('../src/main/migration.ts', import.meta.url), 'utf8')
const permissions = readFileSync(new URL('../src/main/permissions.ts', import.meta.url), 'utf8')

describe('M25 — migration must never delete the only copy', () => {
  it('guards the destructive branch before the rm', () => {
    const fn = migration.slice(migration.indexOf('async function migrateHomeDirectory'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    const sameAt = body.indexOf('resolvesToSame')
    const symlinkAt = body.indexOf('isSymlink')
    const rmAt = body.indexOf('fs.rm(LEGACY_HOME')
    assert.ok(sameAt > -1 && symlinkAt > -1 && rmAt > -1)
    assert.ok(sameAt < rmAt, 'the same-directory check must precede the delete')
    assert.ok(symlinkAt < rmAt, 'the symlink check must precede the delete')
  })

  it('uses lstat, which does not follow symlinks', () => {
    const fn = migration.slice(migration.indexOf('async function isSymlink'))
    assert.ok(fn.slice(0, 200).includes('fs.lstat'), 'fs.access/stat would follow the link')
  })

  it('behaviour: a self-referential symlink is detected as the same directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codesurf-mig-'))
    try {
      const real = join(root, 'contex')
      const link = join(root, 'codesurf')
      await fs.mkdir(real)
      await fs.writeFile(join(real, 'config.json'), '{"important":true}')
      await fs.symlink(real, link)

      // Both "exist" under access(), which is what the old code checked.
      await fs.access(real)
      await fs.access(link)

      // But they resolve to the same real path — the new guard.
      assert.equal(await fs.realpath(real), await fs.realpath(link))

      // And lstat sees the link for what it is.
      assert.equal((await fs.lstat(link)).isSymbolicLink(), true)
      assert.equal((await fs.lstat(real)).isSymbolicLink(), false)

      // The data survives because the guard aborts before any rm.
      assert.equal(await fs.readFile(join(real, 'config.json'), 'utf8'), '{"important":true}')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('behaviour: two genuinely distinct dirs are not confused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codesurf-mig2-'))
    try {
      const a = join(root, 'a')
      const b = join(root, 'b')
      await fs.mkdir(a); await fs.mkdir(b)
      assert.notEqual(await fs.realpath(a), await fs.realpath(b), 'a real merge must still proceed')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('M26 — the permission dialog must default to Deny', () => {
  it('Return does not activate an approval', () => {
    const fn = permissions.slice(permissions.indexOf("buttons: ['Deny', 'Never'"))
    const opts = fn.slice(0, fn.indexOf('}'))
    assert.ok(opts.includes('defaultId: 0'), 'the default button must be Deny')
    assert.ok(opts.includes('cancelId: 0'), 'Escape must also deny')
    assert.equal(/defaultId: [1-9]/.test(opts), false, 'no positive scope may be the default')
  })

  it('button order still puts the negative decisions first', () => {
    const fn = permissions.slice(permissions.indexOf("buttons: ['Deny', 'Never'"))
    const line = fn.slice(0, fn.indexOf('\n'))
    assert.match(line, /\['Deny', 'Never',/)
  })

  it('matches the sibling security dialog it was inconsistent with', () => {
    const boundary = readFileSync(
      new URL('../src/main/security/permissionBoundary.ts', import.meta.url), 'utf8')
    assert.ok(/defaultId: 1/.test(boundary) || /defaultId: cancelId/.test(boundary),
      'the sibling dialog defaults to its deny button')
  })
})

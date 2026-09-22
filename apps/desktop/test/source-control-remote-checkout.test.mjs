import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const src = readFileSync(new URL('../bundled-extensions/source-control/main.js', import.meta.url), 'utf8')

// Extract the pure helper so it can be exercised without booting the extension.
const fnSrc = src.slice(src.indexOf('function resolveBranchCheckout'))
const resolveBranchCheckout = new Function(
  `${fnSrc.slice(0, fnSrc.indexOf('\n}\n') + 3)}; return resolveBranchCheckout`,
)()

describe('resolveBranchCheckout', () => {
  it('leaves a local branch alone', () => {
    assert.deepEqual(resolveBranchCheckout('main'), { local: 'main', trackFrom: null })
    assert.deepEqual(resolveBranchCheckout('feature/x'), { local: 'feature/x', trackFrom: null })
  })

  it('maps origin/<branch> to a local tracking checkout', () => {
    assert.deepEqual(resolveBranchCheckout('origin/feature'), {
      local: 'feature', trackFrom: 'origin/feature',
    })
  })

  it('handles the remotes/ prefix git emits', () => {
    assert.deepEqual(resolveBranchCheckout('remotes/origin/feature'), {
      local: 'feature', trackFrom: 'origin/feature',
    })
  })

  it('handles upstream and nested branch names', () => {
    assert.deepEqual(resolveBranchCheckout('upstream/release/2.0'), {
      local: 'release/2.0', trackFrom: 'upstream/release/2.0',
    })
  })

  it('is empty for empty input', () => {
    assert.deepEqual(resolveBranchCheckout(''), { local: '', trackFrom: null })
  })
})

describe('checkout of a remote branch keeps HEAD attached (real git)', () => {
  it('produces a tracking branch, not a detached HEAD', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codesurf-git-'))
    const remote = join(dir, 'remote')
    const clone = join(dir, 'clone')
    const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    try {
      execFileSync('git', ['init', '-q', '--bare', remote])
      execFileSync('git', ['clone', '-q', remote, clone])
      git(clone, ['config', 'user.email', 't@example.com'])
      git(clone, ['config', 'user.name', 'T'])
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: clone })
      git(clone, ['branch', '-M', 'main'])
      git(clone, ['push', '-q', '-u', 'origin', 'main'])
      git(clone, ['checkout', '-q', '-b', 'feature'])
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'work'], { cwd: clone })
      git(clone, ['push', '-q', '-u', 'origin', 'feature'])
      git(clone, ['checkout', '-q', 'main'])
      git(clone, ['branch', '-q', '-D', 'feature'])
      git(clone, ['fetch', '-q'])

      // The OLD behaviour: bare checkout of the remote ref detaches HEAD.
      git(clone, ['checkout', '-q', 'origin/feature'])
      assert.equal(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD',
        'sanity: the old code path really does detach HEAD')
      git(clone, ['checkout', '-q', 'main'])

      // The NEW behaviour.
      const { local, trackFrom } = resolveBranchCheckout('origin/feature')
      execFileSync('git', ['checkout', '-q', '-b', local, '--track', trackFrom], { cwd: clone })
      assert.equal(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature',
        'HEAD must be attached to a real local branch')
      assert.equal(git(clone, ['rev-parse', '--abbrev-ref', 'feature@{upstream}']), 'origin/feature',
        'the local branch must track the remote')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('getPorcelainBranches', () => {
  it('no longer discards the remote flag', () => {
    assert.ok(src.includes('branchDetails'), 'remote/current flags must be exposed')
    assert.ok(/remote: Boolean\(branch\.remote\)/.test(src), 'the remote flag must be preserved')
  })
})

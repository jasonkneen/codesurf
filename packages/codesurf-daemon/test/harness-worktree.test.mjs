import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isGitRepo,
  createSessionWorktree,
  changedFiles,
  changedFilesAbsolute,
  ignoredCreated,
  applyPaths,
  applyWorktree,
  removeWorktree,
} from '../bin/harness-worktree.mjs'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

// Fresh git repo: committed.txt (committed), dirty.txt (committed then modified),
// untracked.txt (new, uncommitted).
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'codesurf-wt-repo-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@codesurf.local'], dir)
  git(['config', 'user.name', 'CodeSurf Test'], dir)
  writeFileSync(join(dir, 'committed.txt'), 'committed-v1\n')
  writeFileSync(join(dir, 'dirty.txt'), 'dirty-v1\n')
  git(['add', '-A'], dir)
  git(['commit', '-qm', 'init'], dir)
  writeFileSync(join(dir, 'dirty.txt'), 'dirty-v2-uncommitted\n') // unstaged modification
  writeFileSync(join(dir, 'untracked.txt'), 'untracked-content\n') // untracked
  return dir
}

test('isGitRepo distinguishes git repos from plain dirs', () => {
  const repo = makeRepo()
  const plain = mkdtempSync(join(tmpdir(), 'codesurf-plain-'))
  try {
    assert.equal(isGitRepo(repo), true)
    assert.equal(isGitRepo(plain), false)
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(plain, { recursive: true, force: true })
  }
})

test('worktree snapshot captures full working state: committed, uncommitted, AND untracked', () => {
  const repo = makeRepo()
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'codesurf-wt-root-'))
  const wt = createSessionWorktree({ workspaceDir: repo, worktreeRoot, sessionId: 's1' })
  try {
    assert.ok(wt, 'worktree handle should be created for a git repo')
    // The worktree must reflect the live working state, not just HEAD.
    assert.equal(readFileSync(join(wt.path, 'committed.txt'), 'utf8'), 'committed-v1\n')
    assert.equal(readFileSync(join(wt.path, 'dirty.txt'), 'utf8'), 'dirty-v2-uncommitted\n')
    assert.equal(readFileSync(join(wt.path, 'untracked.txt'), 'utf8'), 'untracked-content\n')
  } finally {
    removeWorktree(wt)
    rmSync(repo, { recursive: true, force: true })
    rmSync(worktreeRoot, { recursive: true, force: true })
  }
})

test('edits in the worktree are isolated from the live workspace until applied', () => {
  const repo = makeRepo()
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'codesurf-wt-root-'))
  const wt = createSessionWorktree({ workspaceDir: repo, worktreeRoot, sessionId: 's2' })
  try {
    // Agent edits inside the worktree.
    writeFileSync(join(wt.path, 'committed.txt'), 'agent-edited\n')
    writeFileSync(join(wt.path, 'new-by-agent.txt'), 'brand-new\n')
    rmSync(join(wt.path, 'untracked.txt'))

    // Live workspace is untouched.
    assert.equal(readFileSync(join(repo, 'committed.txt'), 'utf8'), 'committed-v1\n')
    assert.equal(existsSync(join(repo, 'new-by-agent.txt')), false)
    assert.equal(existsSync(join(repo, 'untracked.txt')), true)

    // changedFiles reports exactly the agent's changes vs the snapshot.
    const changed = changedFiles(wt).sort()
    assert.deepEqual(changed, ['committed.txt', 'new-by-agent.txt', 'untracked.txt'])
    const abs = changedFilesAbsolute(wt)
    assert.ok(abs.every(p => p.startsWith(wt.repo)))
  } finally {
    removeWorktree(wt)
    rmSync(repo, { recursive: true, force: true })
    rmSync(worktreeRoot, { recursive: true, force: true })
  }
})

test('applyWorktree lands the agent diff (add/modify/delete) on the live workspace', () => {
  const repo = makeRepo()
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'codesurf-wt-root-'))
  const wt = createSessionWorktree({ workspaceDir: repo, worktreeRoot, sessionId: 's3' })
  try {
    writeFileSync(join(wt.path, 'committed.txt'), 'agent-edited\n') // modify
    writeFileSync(join(wt.path, 'new-by-agent.txt'), 'brand-new\n') // add
    rmSync(join(wt.path, 'untracked.txt')) // delete

    const result = applyWorktree(wt)
    assert.equal(result.ok, true)
    assert.equal(result.applied, true)

    assert.equal(readFileSync(join(repo, 'committed.txt'), 'utf8'), 'agent-edited\n')
    assert.equal(readFileSync(join(repo, 'new-by-agent.txt'), 'utf8'), 'brand-new\n')
    assert.equal(existsSync(join(repo, 'untracked.txt')), false)
  } finally {
    removeWorktree(wt)
    rmSync(repo, { recursive: true, force: true })
    rmSync(worktreeRoot, { recursive: true, force: true })
  }
})

test('applyWorktree on an unchanged worktree is a no-op', () => {
  const repo = makeRepo()
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'codesurf-wt-root-'))
  const wt = createSessionWorktree({ workspaceDir: repo, worktreeRoot, sessionId: 's4' })
  try {
    const result = applyWorktree(wt)
    assert.equal(result.ok, true)
    assert.equal(result.applied, false)
    assert.equal(result.empty, true)
  } finally {
    removeWorktree(wt)
    rmSync(repo, { recursive: true, force: true })
    rmSync(worktreeRoot, { recursive: true, force: true })
  }
})

test('removeWorktree detaches the worktree from the repo', () => {
  const repo = makeRepo()
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'codesurf-wt-root-'))
  const wt = createSessionWorktree({ workspaceDir: repo, worktreeRoot, sessionId: 's5' })
  removeWorktree(wt)
  try {
    assert.equal(existsSync(wt.path), false)
    const list = git(['worktree', 'list'], repo)
    assert.equal(list.includes(wt.path), false)
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(worktreeRoot, { recursive: true, force: true })
  }
})

test('gitignored files the agent creates are recovered (not dropped by the diff) and applied', () => {
  const repo = makeRepo()
  // Ignore secret.env so git's diff would omit it.
  writeFileSync(join(repo, '.gitignore'), 'secret.env\n')
  git(['add', '-A'], repo)
  git(['commit', '-qm', 'add gitignore'], repo)
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'codesurf-wt-root-'))
  const wt = createSessionWorktree({ workspaceDir: repo, worktreeRoot, sessionId: 'gi' })
  try {
    // Agent creates a gitignored file inside the worktree.
    writeFileSync(join(wt.path, 'secret.env'), 'KEY=123\n')

    // git's tracked diff misses it...
    assert.equal(changedFiles(wt).includes('secret.env'), false)
    // ...but ignoredCreated catches it.
    assert.deepEqual(ignoredCreated(wt), ['secret.env'])

    // Applying it lands the file in the live workspace.
    const result = applyPaths(wt, ignoredCreated(wt))
    assert.equal(result.ok, true)
    assert.equal(readFileSync(join(repo, 'secret.env'), 'utf8'), 'KEY=123\n')
  } finally {
    removeWorktree(wt)
    rmSync(repo, { recursive: true, force: true })
    rmSync(worktreeRoot, { recursive: true, force: true })
  }
})

test('createSessionWorktree returns null for a non-git workspace', () => {
  const plain = mkdtempSync(join(tmpdir(), 'codesurf-plain-'))
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'codesurf-wt-root-'))
  try {
    const wt = createSessionWorktree({ workspaceDir: plain, worktreeRoot, sessionId: 's6' })
    assert.equal(wt, null)
  } finally {
    rmSync(plain, { recursive: true, force: true })
    rmSync(worktreeRoot, { recursive: true, force: true })
  }
})

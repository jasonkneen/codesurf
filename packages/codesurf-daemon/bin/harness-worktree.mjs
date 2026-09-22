// Git-worktree snapshots for harness turns.
//
// A harness turn runs against an isolated git worktree instead of the user's
// live workspace, so the agent's edits are contained until the turn succeeds.
// After a successful turn we register a checkpoint of the pre-turn state (so the
// existing CodeSurf undo works) and apply the agent's diff back to the live
// workspace. On error/abort the worktree is discarded and the live workspace is
// never touched.
//
// The snapshot captures the FULL current working state — committed + staged +
// unstaged + untracked (respecting .gitignore) — without mutating the user's
// index or working tree, via a throwaway GIT_INDEX_FILE.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'

function git(args, cwd, { env, input, quiet } = {}) {
  return execFileSync('git', args, {
    cwd,
    input,
    env: env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', quiet ? 'ignore' : 'pipe'],
  })
}

export function isGitRepo(dir) {
  try {
    return git(['rev-parse', '--is-inside-work-tree'], dir, { quiet: true }).trim() === 'true'
  } catch {
    return false
  }
}

export function repoToplevel(dir) {
  return git(['rev-parse', '--show-toplevel'], dir, { quiet: true }).trim()
}

// Build a commit capturing the full current working state without touching the
// user's index/worktree. Returns { base, snapshot } commit SHAs (base may be
// null for an empty repo).
function snapshotWorkingState(repo) {
  const idxDir = mkdtempSync(join(tmpdir(), 'codesurf-snap-idx-'))
  const env = { ...process.env, GIT_INDEX_FILE: join(idxDir, 'index') }
  try {
    let base = null
    try { base = git(['rev-parse', 'HEAD'], repo, { quiet: true }).trim() } catch { base = null }
    if (base) git(['read-tree', base], repo, { env, quiet: true })
    git(['add', '-A'], repo, { env, quiet: true })
    const tree = git(['write-tree'], repo, { env, quiet: true }).trim()
    const parent = base ? ['-p', base] : []
    const snapshot = git(['commit-tree', tree, ...parent, '-m', 'codesurf-harness-snapshot'], repo, { env, quiet: true }).trim()
    return { base, snapshot }
  } finally {
    rmSync(idxDir, { recursive: true, force: true })
  }
}

// Create an isolated worktree checked out to the snapshot of the current state.
// Returns a handle, or null if the directory is not a git repo.
export function createSessionWorktree({ workspaceDir, worktreeRoot, sessionId }) {
  if (!isGitRepo(workspaceDir)) return null
  const repo = repoToplevel(workspaceDir)
  const { base, snapshot } = snapshotWorkingState(repo)
  const path = join(worktreeRoot, `ws-${sessionId}`)
  if (existsSync(path)) {
    try { git(['worktree', 'remove', '--force', path], repo, { quiet: true }) } catch {}
    rmSync(path, { recursive: true, force: true })
  }
  git(['worktree', 'add', '--detach', path, snapshot], repo, { quiet: true })
  return { repo, path, base, snapshot }
}

// Repo-relative GIT-TRACKED changes the agent made in the worktree (added/
// modified/deleted vs the pre-turn snapshot). Excludes .gitignore'd paths.
export function changedFiles(wt) {
  git(['add', '-A'], wt.path, { quiet: true })
  const out = git(['diff', '--name-only', '--cached', wt.snapshot], wt.path, { quiet: true })
  return out.split('\n').map(s => s.trim()).filter(Boolean)
}

// Repo-relative GITIGNORED files the agent created in the worktree. The snapshot
// is built with `git add -A` (which omits ignored paths), so the worktree starts
// with no ignored files — any present afterward are the agent's own writes that
// git's diff would otherwise silently drop (e.g. .env.local, generated config).
export function ignoredCreated(wt) {
  const out = git(['ls-files', '--others', '--ignored', '--exclude-standard'], wt.path, { quiet: true })
  return out.split('\n').map(s => s.trim()).filter(Boolean)
}

export function changedFilesAbsolute(wt) {
  return changedFiles(wt).map(p => (isAbsolute(p) ? p : join(wt.repo, p)))
}

export function ignoredCreatedAbsolute(wt) {
  return ignoredCreated(wt).map(p => (isAbsolute(p) ? p : join(wt.repo, p)))
}

// Unified binary-safe patch of the agent's changes vs the snapshot — for
// review/diff display in the UI.
export function diffWorktree(wt) {
  git(['add', '-A'], wt.path, { quiet: true })
  return git(['diff', '--cached', '--binary', wt.snapshot], wt.path, { quiet: true })
}

// The file's content in the pre-turn snapshot, or null if it didn't exist then.
function snapshotContent(wt, rel) {
  try {
    return execFileSync('git', ['show', `${wt.snapshot}:${rel}`], {
      cwd: wt.repo, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

// Apply a specific set of repo-relative paths from the worktree onto the live
// workspace by content sync (robust across tracked/untracked/binary/ignored,
// unlike `git apply --index`). A path present in the worktree is copied; a path
// absent from the worktree is deleted from the live workspace. Detects files the
// live workspace changed since the snapshot (concurrent edits) into `conflicts`
// — the agent's version still wins, but the caller can surface the overwrite.
export function applyPaths(wt, relPaths) {
  if (!relPaths.length) return { ok: true, applied: false, empty: true, conflicts: [] }
  const conflicts = []
  try {
    for (const rel of relPaths) {
      const livePath = join(wt.repo, rel)
      const wtPath = join(wt.path, rel)
      const base = snapshotContent(wt, rel)
      const liveNow = existsSync(livePath) ? readFileSync(livePath) : null
      if (liveNow != null && (base == null || !liveNow.equals(base))) conflicts.push(rel)

      if (existsSync(wtPath)) {
        mkdirSync(dirname(livePath), { recursive: true })
        writeFileSync(livePath, readFileSync(wtPath))
      } else if (existsSync(livePath)) {
        rmSync(livePath, { force: true })
      }
    }
    return { ok: true, applied: true, conflicts }
  } catch (e) {
    return { ok: false, applied: false, conflicts, error: e.message }
  }
}

// Convenience: apply the agent's git-tracked changes (used by tests).
export function applyWorktree(wt) {
  return applyPaths(wt, changedFiles(wt))
}

export function removeWorktree(wt) {
  if (!wt) return
  try { git(['worktree', 'remove', '--force', wt.path], wt.repo, { quiet: true }) } catch {}
  try { if (existsSync(wt.path)) rmSync(wt.path, { recursive: true, force: true }) } catch {}
  try { git(['worktree', 'prune'], wt.repo, { quiet: true }) } catch {}
}

void dirname

import { useState, useRef, useEffect, useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────

export interface GitStatusSummary {
  isRepo: boolean
  root: string
  changedCount: number
}

export interface GitBranchSummary {
  isRepo: boolean
  root: string
  current: string | null
  branches: Array<{ name: string; current: boolean }>
}

interface CachedGitState {
  status: GitStatusSummary
  branches: GitBranchSummary
  fetchedAt: number
}

// ─── Module-level cache (shared across all chat tiles) ────────────────────

const GIT_STATE_CACHE_TTL_MS = 15_000
const gitStateCache = new Map<string, CachedGitState>()
const gitStateInflight = new Map<string, Promise<CachedGitState>>()

function normalizeGitWorkspaceKey(workspaceDir: string): string {
  return workspaceDir.replace(/\/+$/, '')
}

function createEmptyGitState(workspaceDir: string): CachedGitState {
  return {
    status: { isRepo: false, root: workspaceDir, changedCount: 0 },
    branches: { isRepo: false, root: workspaceDir, current: null, branches: [] },
    fetchedAt: 0,
  }
}

function getCachedGitState(workspaceDir: string): CachedGitState | null {
  if (!workspaceDir) return null
  return gitStateCache.get(normalizeGitWorkspaceKey(workspaceDir)) ?? null
}

function isFreshGitState(entry: CachedGitState | null | undefined): entry is CachedGitState {
  return Boolean(entry) && (Date.now() - entry!.fetchedAt) < GIT_STATE_CACHE_TTL_MS
}

async function loadGitState(workspaceDir: string, force = false): Promise<CachedGitState> {
  if (!workspaceDir || !window.electron?.git) return createEmptyGitState(workspaceDir)

  const cacheKey = normalizeGitWorkspaceKey(workspaceDir)
  const cached = gitStateCache.get(cacheKey)
  if (!force && isFreshGitState(cached)) return cached

  const pending = gitStateInflight.get(cacheKey)
  if (!force && pending) return pending

  const request = (async () => {
    try {
      const git = window.electron!.git!
      const [statusResult, branchResult] = await Promise.all([
        git.status(workspaceDir),
        git.branches(workspaceDir),
      ])

      const next: CachedGitState = {
        status: {
          isRepo: statusResult?.isRepo === true,
          root: statusResult?.root ?? workspaceDir,
          changedCount: Array.isArray(statusResult?.files) ? statusResult.files.length : 0,
        },
        branches: {
          isRepo: branchResult?.isRepo === true,
          root: branchResult?.root ?? workspaceDir,
          current: branchResult?.current ?? null,
          branches: Array.isArray(branchResult?.branches) ? branchResult.branches : [],
        },
        fetchedAt: Date.now(),
      }
      gitStateCache.set(cacheKey, next)
      return next
    } catch {
      const empty: CachedGitState = { ...createEmptyGitState(workspaceDir), fetchedAt: Date.now() }
      gitStateCache.set(cacheKey, empty)
      return empty
    } finally {
      gitStateInflight.delete(cacheKey)
    }
  })()

  gitStateInflight.set(cacheKey, request)
  return request
}

// ─── Hook ─────────────────────────────────────────────────────────────────

export interface UseChatGitStateResult {
  gitStatus: GitStatusSummary
  gitBranches: GitBranchSummary
  refreshGitState: (force?: boolean) => Promise<void>
}

export function useChatGitState(workspaceDir: string): UseChatGitStateResult {
  const [gitStatus, setGitStatus] = useState<GitStatusSummary>(
    () => getCachedGitState(workspaceDir)?.status ?? createEmptyGitState(workspaceDir).status,
  )
  const [gitBranches, setGitBranches] = useState<GitBranchSummary>(
    () => getCachedGitState(workspaceDir)?.branches ?? createEmptyGitState(workspaceDir).branches,
  )
  const latestGitWorkspaceKeyRef = useRef(normalizeGitWorkspaceKey(workspaceDir))

  const applyGitState = useCallback((next: CachedGitState) => {
    setGitStatus(next.status)
    setGitBranches(next.branches)
  }, [])

  const refreshGitState = useCallback(async (force = false) => {
    const requestWorkspaceDir = workspaceDir
    const requestKey = normalizeGitWorkspaceKey(requestWorkspaceDir)
    if (!requestWorkspaceDir) {
      applyGitState(createEmptyGitState(workspaceDir))
      return
    }

    const cached = getCachedGitState(requestWorkspaceDir)
    if (!force && cached) {
      if (latestGitWorkspaceKeyRef.current === requestKey) applyGitState(cached)
      if (isFreshGitState(cached)) return
    }

    const next = await loadGitState(requestWorkspaceDir, force)
    if (latestGitWorkspaceKeyRef.current !== requestKey) return
    applyGitState(next)
  }, [workspaceDir, applyGitState])

  useEffect(() => {
    latestGitWorkspaceKeyRef.current = normalizeGitWorkspaceKey(workspaceDir)
    const cached = getCachedGitState(workspaceDir)
    applyGitState(cached ?? createEmptyGitState(workspaceDir))
    void refreshGitState(false)

    const onFocus = () => { void refreshGitState(true) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [workspaceDir, applyGitState, refreshGitState])

  return { gitStatus, gitBranches, refreshGitState }
}

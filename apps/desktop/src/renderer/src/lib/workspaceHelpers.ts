import type { Workspace } from '../../../shared/types'
import { basename } from '../utils/dnd'

export function normalizeWorkspacePath(path: string | null | undefined): string {
  return String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

export function getWorkspaceProjectPaths(workspace: Workspace): string[] {
  const seen = new Set<string>()
  const next: string[] = []
  const push = (path: string | null | undefined) => {
    const normalized = normalizeWorkspacePath(path)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    next.push(normalized)
  }
  push(workspace.path)
  for (const projectPath of workspace.projectPaths ?? []) push(projectPath)
  return next
}

export function isLayoutVariantWorkspace(workspace: Workspace, projectPath?: string | null): boolean {
  const normalizedProjectPath = normalizeWorkspacePath(projectPath ?? workspace.path)
  const projectBase = basename(normalizedProjectPath)
  const workspaceName = workspace.name?.trim() ?? ''
  if (!normalizedProjectPath || !projectBase || !workspaceName.startsWith(`${projectBase}:`)) return false
  const projectPaths = getWorkspaceProjectPaths(workspace)
  return projectPaths.length === 1 && projectPaths[0] === normalizedProjectPath
}

export function getCanonicalWorkspaceId(workspaceList: Workspace[], workspaceId: string | null | undefined): string | null {
  if (!workspaceId) return null
  const target = workspaceList.find(candidate => candidate.id === workspaceId) ?? null
  if (!target) return null

  const normalizedProjectPath = normalizeWorkspacePath(target.path)
  if (!normalizedProjectPath || !isLayoutVariantWorkspace(target, normalizedProjectPath)) return target.id

  const canonical = workspaceList.find(candidate =>
    candidate.id !== target.id
    && normalizeWorkspacePath(candidate.path) === normalizedProjectPath
    && !isLayoutVariantWorkspace(candidate, normalizedProjectPath),
  ) ?? null

  return canonical?.id ?? target.id
}

export function resolveWorkspaceCandidateForProjectPath(
  workspaceList: Workspace[],
  projectPath: string | null | undefined,
  currentWorkspaceId?: string | null,
): Workspace | null {
  const normalizedProjectPath = normalizeWorkspacePath(projectPath)
  if (!normalizedProjectPath) {
    const canonicalCurrentId = getCanonicalWorkspaceId(workspaceList, currentWorkspaceId)
    return canonicalCurrentId
      ? (workspaceList.find(candidate => candidate.id === canonicalCurrentId) ?? null)
      : null
  }

  const canonicalCurrentId = getCanonicalWorkspaceId(workspaceList, currentWorkspaceId)
  const currentWorkspace = canonicalCurrentId
    ? (workspaceList.find(candidate => candidate.id === canonicalCurrentId) ?? null)
    : null

  const currentWorkspacePath = normalizeWorkspacePath(currentWorkspace?.path)
  const currentWorkspaceProjects = currentWorkspace ? new Set(getWorkspaceProjectPaths(currentWorkspace)) : new Set<string>()

  if (currentWorkspace && currentWorkspaceProjects.has(normalizedProjectPath) && currentWorkspacePath !== normalizedProjectPath) {
    return currentWorkspace
  }

  if (currentWorkspace && currentWorkspacePath === normalizedProjectPath && !isLayoutVariantWorkspace(currentWorkspace, normalizedProjectPath)) {
    return currentWorkspace
  }

  const exactMatches = workspaceList.filter(candidate => normalizeWorkspacePath(candidate.path) === normalizedProjectPath)
  const canonicalExactMatch = exactMatches.find(candidate => !isLayoutVariantWorkspace(candidate, normalizedProjectPath)) ?? null
  if (canonicalExactMatch) return canonicalExactMatch

  if (currentWorkspace && exactMatches.some(candidate => candidate.id === currentWorkspace.id)) {
    return currentWorkspace
  }
  if (exactMatches.length > 0) return exactMatches[0]

  if (currentWorkspace && currentWorkspaceProjects.has(normalizedProjectPath)) {
    return currentWorkspace
  }

  const projectMatches = workspaceList.filter(candidate => getWorkspaceProjectPaths(candidate).includes(normalizedProjectPath))
  const canonicalProjectMatch = projectMatches.find(candidate => !isLayoutVariantWorkspace(candidate, normalizedProjectPath)) ?? null
  return canonicalProjectMatch ?? projectMatches[0] ?? null
}
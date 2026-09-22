export function applyProjectContextPolicy({ executionTarget = 'local', projectContext = {} } = {}) {
  const raw = {
    workspaceDir: normalizeNullableString(projectContext.workspaceDir),
    gitRemoteUrl: normalizeNullableString(projectContext.gitRemoteUrl),
    gitBranch: normalizeNullableString(projectContext.gitBranch),
    repoName: normalizeNullableString(projectContext.repoName),
  }

  const remoteBoundary = executionTarget === 'cloud'
  const workspaceDir = remoteBoundary && raw.gitRemoteUrl ? null : raw.workspaceDir

  return {
    workspaceDir,
    gitRemoteUrl: raw.gitRemoteUrl,
    gitBranch: raw.gitBranch,
    repoName: raw.repoName,
  }
}

function normalizeNullableString(value) {
  const text = String(value ?? '').trim()
  return text ? text : null
}

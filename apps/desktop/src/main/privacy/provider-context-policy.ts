import type { ExecutionHostType } from '../../shared/types'

export interface ProjectContextEnvelope {
  workspaceDir: string | null
  gitRemoteUrl: string | null
  gitBranch: string | null
  repoName: string | null
}

export interface ProviderContextPolicy {
  includeWorkspaceDir: boolean
  includeGitRemoteUrl: boolean
  includeGitBranch: boolean
  includeRepoName: boolean
  reason: string
}

export function buildProviderContextPolicy(args: {
  executionTarget?: 'local' | 'cloud'
  hostType?: ExecutionHostType | null
}): ProviderContextPolicy {
  const executionTarget = args.executionTarget ?? 'local'
  const hostType = args.hostType ?? 'runtime'
  const remoteBoundary = executionTarget === 'cloud' || hostType === 'remote-daemon'

  if (remoteBoundary) {
    return {
      // Strip local paths from remote context by default — but allow workspaceDir
      // as a fallback when there is no git remote URL to identify the repo.
      // The fallback is applied in applyProjectContextPolicy, not here.
      includeWorkspaceDir: false,
      includeGitRemoteUrl: true,
      includeGitBranch: true,
      includeRepoName: true,
      reason: 'remote-boundary',
    }
  }

  return {
    includeWorkspaceDir: true,
    includeGitRemoteUrl: true,
    includeGitBranch: true,
    includeRepoName: true,
    reason: 'local-execution',
  }
}

export function applyProjectContextPolicy(
  context: ProjectContextEnvelope,
  policy: ProviderContextPolicy,
): ProjectContextEnvelope {
  // When policy strips workspaceDir (remote boundary) but there is no git
  // remote URL to identify the repo, preserve workspaceDir as a fallback so
  // the agent can still locate its working directory.
  const workspaceDir = policy.includeWorkspaceDir
    ? context.workspaceDir
    : !context.gitRemoteUrl ? context.workspaceDir : null

  return {
    workspaceDir,
    gitRemoteUrl: policy.includeGitRemoteUrl ? context.gitRemoteUrl : null,
    gitBranch: policy.includeGitBranch ? context.gitBranch : null,
    repoName: policy.includeRepoName ? context.repoName : null,
  }
}

export function describeProjectContextEnvelope(context: ProjectContextEnvelope): {
  hasWorkspaceDir: boolean
  hasGitRemoteUrl: boolean
  hasGitBranch: boolean
  hasRepoName: boolean
} {
  return {
    hasWorkspaceDir: Boolean(context.workspaceDir),
    hasGitRemoteUrl: Boolean(context.gitRemoteUrl),
    hasGitBranch: Boolean(context.gitBranch),
    hasRepoName: Boolean(context.repoName),
  }
}

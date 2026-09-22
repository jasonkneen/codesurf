import test from 'node:test'
import assert from 'node:assert/strict'
import { applyProjectContextPolicy } from '../bin/project-context.mjs'

test('daemon local execution keeps full project context', () => {
  const output = applyProjectContextPolicy({
    executionTarget: 'local',
    projectContext: {
      workspaceDir: '/tmp/project',
      gitRemoteUrl: 'git@github.com:jkneen/codesurf.git',
      gitBranch: 'main',
      repoName: 'codesurf',
    },
  })

  assert.deepEqual(output, {
    workspaceDir: '/tmp/project',
    gitRemoteUrl: 'git@github.com:jkneen/codesurf.git',
    gitBranch: 'main',
    repoName: 'codesurf',
  })
})

test('daemon cloud execution strips local workspaceDir when git remote exists', () => {
  const output = applyProjectContextPolicy({
    executionTarget: 'cloud',
    projectContext: {
      workspaceDir: '/Users/jkneen/clawd/collaborator-clone',
      gitRemoteUrl: 'git@github.com:jkneen/codesurf.git',
      gitBranch: 'feature/event-bus-mcp',
      repoName: 'codesurf',
    },
  })

  assert.deepEqual(output, {
    workspaceDir: null,
    gitRemoteUrl: 'git@github.com:jkneen/codesurf.git',
    gitBranch: 'feature/event-bus-mcp',
    repoName: 'codesurf',
  })
})

test('daemon cloud execution preserves workspaceDir fallback when no git remote exists', () => {
  const output = applyProjectContextPolicy({
    executionTarget: 'cloud',
    projectContext: {
      workspaceDir: '/Users/jkneen/scratch/no-remote',
      gitRemoteUrl: null,
      gitBranch: null,
      repoName: 'no-remote',
    },
  })

  assert.deepEqual(output, {
    workspaceDir: '/Users/jkneen/scratch/no-remote',
    gitRemoteUrl: null,
    gitBranch: null,
    repoName: 'no-remote',
  })
})

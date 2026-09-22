import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const modulePath = path.resolve(__dirname, '../../src/main/privacy/provider-context-policy.ts')

function runExpression(expression) {
  const result = spawnSync(
    'node',
    [
      '--experimental-strip-types',
      '--input-type=module',
      '--eval',
      `import * as mod from ${JSON.stringify(`file://${modulePath}`)}; const value = (${expression}); console.log(JSON.stringify(value));`,
    ],
    {
      encoding: 'utf8',
    },
  )

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `node exited with ${result.status}`)
  }

  return JSON.parse(result.stdout.trim())
}

test('local execution keeps full project context', () => {
  const output = runExpression(`mod.applyProjectContextPolicy(
    {
      workspaceDir: '/tmp/project',
      gitRemoteUrl: 'git@github.com:jkneen/codesurf.git',
      gitBranch: 'main',
      repoName: 'codesurf',
    },
    mod.buildProviderContextPolicy({ executionTarget: 'local', hostType: 'runtime' }),
  )`)

  assert.deepEqual(output, {
    workspaceDir: '/tmp/project',
    gitRemoteUrl: 'git@github.com:jkneen/codesurf.git',
    gitBranch: 'main',
    repoName: 'codesurf',
  })
})

test('remote daemon strips workspaceDir when git remote exists', () => {
  const output = runExpression(`mod.applyProjectContextPolicy(
    {
      workspaceDir: '/Users/jkneen/clawd/collaborator-clone',
      gitRemoteUrl: 'git@github.com:jkneen/codesurf.git',
      gitBranch: 'feature/event-bus-mcp',
      repoName: 'codesurf',
    },
    mod.buildProviderContextPolicy({ executionTarget: 'cloud', hostType: 'remote-daemon' }),
  )`)

  assert.deepEqual(output, {
    workspaceDir: null,
    gitRemoteUrl: 'git@github.com:jkneen/codesurf.git',
    gitBranch: 'feature/event-bus-mcp',
    repoName: 'codesurf',
  })
})

test('remote daemon preserves workspaceDir as fallback when no git remote exists', () => {
  const output = runExpression(`mod.applyProjectContextPolicy(
    {
      workspaceDir: '/Users/jkneen/scratch/no-remote',
      gitRemoteUrl: null,
      gitBranch: null,
      repoName: 'no-remote',
    },
    mod.buildProviderContextPolicy({ executionTarget: 'cloud', hostType: 'remote-daemon' }),
  )`)

  assert.deepEqual(output, {
    workspaceDir: '/Users/jkneen/scratch/no-remote',
    gitRemoteUrl: null,
    gitBranch: null,
    repoName: 'no-remote',
  })
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { isInternalMaintenanceSession } from '../../src/renderer/src/components/sidebar/session-filters.ts'

function session(title) {
  return {
    id: `session-${title}`,
    workspaceId: 'ws',
    workspaceName: 'Workspace',
    workspacePath: '/workspace/project',
    source: 'claude',
    scope: 'project',
    tileId: null,
    sessionId: null,
    provider: 'claude',
    model: '',
    messageCount: 2,
    lastMessage: title,
    updatedAt: 100,
    title,
    projectPath: '/workspace/project',
    sourceLabel: 'Claude',
    sourceDetail: 'main',
  }
}

test('sidebar hides generated workspace memory maintenance sessions', () => {
  assert.equal(
    isInternalMaintenanceSession(session('Update the generated workspace memory file for CodeSurf. Return ONLY the full replacement content.')),
    true,
  )
})

test('sidebar hides generated agent metadata maintenance sessions', () => {
  assert.equal(
    isInternalMaintenanceSession(session('Generate metadata for a coding agent based on the user prompt. Title: Fix renderer issue')),
    true,
  )
})

test('sidebar keeps normal user sessions visible', () => {
  assert.equal(
    isInternalMaintenanceSession(session('annotate that image ## Reference')),
    false,
  )
})

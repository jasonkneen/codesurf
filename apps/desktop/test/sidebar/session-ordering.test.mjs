import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applySessionPromotions,
  compareSessionsWithSelectionPriority,
  isSessionActive,
  sortProjectEntriesByRecentSession,
} from '../../src/renderer/src/components/sidebar/session-ordering.ts'

const projects = [
  {
    id: 'project-alpha',
    name: 'Alpha',
    path: '/workspace/alpha',
    workspaceIds: ['ws-alpha'],
    representativeWorkspaceId: 'ws-alpha',
  },
  {
    id: 'project-beta',
    name: 'Beta',
    path: '/workspace/beta',
    workspaceIds: ['ws-beta'],
    representativeWorkspaceId: 'ws-beta',
  },
]

const sessions = [
  {
    id: 'session-alpha-old',
    workspaceId: 'ws-alpha',
    workspaceName: 'Alpha',
    workspacePath: '/workspace/alpha',
    source: 'codesurf',
    scope: 'workspace',
    tileId: null,
    sessionId: 'alpha-1',
    provider: 'claude',
    model: 'sonnet',
    messageCount: 4,
    lastMessage: 'Old alpha thread',
    updatedAt: 100,
    title: 'Alpha old',
    projectPath: '/workspace/alpha',
    sourceLabel: 'CodeSurf',
    relatedGroupId: null,
    nestingLevel: 0,
  },
  {
    id: 'session-beta-newer',
    workspaceId: 'ws-beta',
    workspaceName: 'Beta',
    workspacePath: '/workspace/beta',
    source: 'codesurf',
    scope: 'workspace',
    tileId: null,
    sessionId: 'beta-1',
    provider: 'claude',
    model: 'sonnet',
    messageCount: 9,
    lastMessage: 'Newer beta thread',
    updatedAt: 200,
    title: 'Beta newer',
    projectPath: '/workspace/beta',
    sourceLabel: 'CodeSurf',
    relatedGroupId: null,
    nestingLevel: 0,
  },
]

test('session ordering promotes the clicked conversation to the top immediately', () => {
  const promoted = applySessionPromotions(sessions, { 'session-alpha-old': 500 })
  const ordered = [...promoted].sort((a, b) => compareSessionsWithSelectionPriority(a, b, 'updated', {
    'session-alpha-old': 500,
  }))

  assert.equal(ordered[0].id, 'session-alpha-old')
  assert.equal(ordered[0].updatedAt, 100)
})

test('project ordering follows the most recently promoted session so the selected conversation is visible at the top', () => {
  const promoted = applySessionPromotions(sessions, { 'session-alpha-old': 500 })
  const orderedProjects = sortProjectEntriesByRecentSession(projects, promoted, project => project.name, {
    'session-alpha-old': 500,
  })

  assert.deepEqual(orderedProjects.map(project => project.id), ['project-alpha', 'project-beta'])
})

test('selection priority beats title sorting so the clicked conversation still jumps to the top', () => {
  const titled = [
    { ...sessions[0], title: 'Zulu thread' },
    { ...sessions[1], title: 'Alpha thread' },
  ]

  const ordered = [...titled].sort((a, b) => compareSessionsWithSelectionPriority(a, b, 'title', {
    'session-alpha-old': 500,
  }))

  assert.equal(ordered[0].id, 'session-alpha-old')
})

test('session selection uses the active conversation match, not only a subtle emphasis hint', () => {
  assert.equal(
    isSessionActive(sessions[0], {
      activeChatTileId: null,
      activeChatSessionId: null,
      activeChatSessionEntryId: 'session-alpha-old',
    }),
    true,
  )

  assert.equal(
    isSessionActive(sessions[1], {
      activeChatTileId: null,
      activeChatSessionId: 'beta-1',
      activeChatSessionEntryId: null,
    }),
    true,
  )

  assert.equal(
    isSessionActive(sessions[1], {
      activeChatTileId: null,
      activeChatSessionId: null,
      activeChatSessionEntryId: 'session-alpha-old',
    }),
    false,
  )
})

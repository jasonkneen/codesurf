import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  peerTileChannel,
  resolvePeerWorkspaceScope,
} from '../src/main/mcp/peer-scope.ts'
import { resolveTerminalPeerWrite } from '../src/renderer/src/components/terminalPeerCommands.ts'

describe('MCP peer workspace scope', () => {
  test('tile principals infer their workspace and reject a forged one', () => {
    const principal = {
      kind: 'tile' as const,
      workspaceId: 'workspace-a',
      tileId: 'caller-a',
    }
    assert.deepEqual(resolvePeerWorkspaceScope(principal, undefined), {
      ok: true,
      workspaceId: 'workspace-a',
    })
    assert.deepEqual(resolvePeerWorkspaceScope(principal, 'workspace-b'), {
      ok: false,
      error: 'Forbidden: token scope does not match the requested workspace',
    })
  })

  test('global principals require a valid workspace', () => {
    assert.deepEqual(resolvePeerWorkspaceScope({ kind: 'global' }, undefined), {
      ok: false,
      error: 'Missing workspace_id',
    })
    assert.deepEqual(resolvePeerWorkspaceScope({ kind: 'global' }, 'bad:scope'), {
      ok: false,
      error: 'Invalid workspace_id',
    })
    assert.deepEqual(resolvePeerWorkspaceScope({ kind: 'global' }, 'workspace-a'), {
      ok: true,
      workspaceId: 'workspace-a',
    })
  })

  test('same tile IDs produce distinct workspace channels', () => {
    assert.equal(peerTileChannel('workspace-a', 'shared-tile'), 'tile:workspace-a:shared-tile')
    assert.equal(peerTileChannel('workspace-b', 'shared-tile'), 'tile:workspace-b:shared-tile')
    assert.notEqual(
      peerTileChannel('workspace-a', 'shared-tile'),
      peerTileChannel('workspace-b', 'shared-tile'),
    )
  })
})

describe('terminal peer command projection', () => {
  test('accepts only the matching workspace and tile', () => {
    const payload = {
      workspaceId: 'workspace-a',
      tileId: 'shared-tile',
      command: 'terminal_send_input',
      input: 'pwd',
      enter: true,
    }
    assert.equal(resolveTerminalPeerWrite('workspace-a', 'shared-tile', payload), 'pwd\r')
    assert.equal(resolveTerminalPeerWrite('workspace-b', 'shared-tile', payload), null)
    assert.equal(resolveTerminalPeerWrite('workspace-a', 'other-tile', payload), null)
  })

  test('defaults Enter on, supports raw input, and maps clear to Ctrl-L', () => {
    assert.equal(resolveTerminalPeerWrite('workspace-a', 'tile-a', {
      workspaceId: 'workspace-a',
      cardId: 'tile-a',
      command: 'terminal_send_input',
      input: 'ls',
    }), 'ls\r')
    assert.equal(resolveTerminalPeerWrite('workspace-a', 'tile-a', {
      workspaceId: 'workspace-a',
      tileId: 'tile-a',
      command: 'terminal_send_input',
      input: 'partial',
      enter: false,
    }), 'partial')
    assert.equal(resolveTerminalPeerWrite('workspace-a', 'tile-a', {
      workspaceId: 'workspace-a',
      tileId: 'tile-a',
      command: 'terminal_clear',
    }), '\x0c')
  })
})

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  getAuthoritativeNegotiatedPeerTools,
  resolveAuthoritativeCanvasPeers,
  selectAuthorizedPeerObservations,
} from '../src/main/chat/peer-authority-policy.ts'
import { buildUntrustedPeerObservationContext } from '../src/main/chat/peer-authority.ts'
import { composeChatContext } from '../src/main/chat/context-composer.ts'
import { authorizePeerBridgeTarget } from '../src/main/mcp/peer-bridge-authority.ts'
import {
  getAllNodeToolNames,
  getDisconnectedPeerBridgeMcpToolNames,
  toCodesurfMcpToolName,
} from '../src/shared/nodeTools.ts'

const canvas = {
  tiles: [
    { id: 'caller-chat', type: 'chat' },
    { id: 'peer-terminal', type: 'terminal' },
    { id: 'peer-chat', type: 'chat' },
    { id: 'peer-note', type: 'note' },
    { id: 'unconnected-browser', type: 'browser' },
  ],
  lockedConnections: [
    { sourceTileId: 'caller-chat', targetTileId: 'peer-terminal' },
    { sourceTileId: 'caller-chat', targetTileId: 'peer-chat' },
    { sourceTileId: 'peer-note', targetTileId: 'caller-chat' },
  ],
}

describe('functional canvas peer authority', () => {
  test('only existing locked neighbors survive renderer-submitted observations', () => {
    const peers = resolveAuthoritativeCanvasPeers(canvas, 'caller-chat')
    assert.deepEqual(peers.map(peer => peer.peerId), ['peer-chat', 'peer-note', 'peer-terminal'])
    assert.deepEqual(peers.map(peer => peer.peerType), ['chat', 'note', 'terminal'])
    const terminal = peers.find(peer => peer.peerId === 'peer-terminal')
    assert.deepEqual(terminal?.tools, getAllNodeToolNames('terminal'))

    const negotiatedTools = getAuthoritativeNegotiatedPeerTools(peers, undefined)
    const disallowed = getDisconnectedPeerBridgeMcpToolNames(negotiatedTools)
    for (const tool of getAllNodeToolNames('terminal')) {
      assert.doesNotMatch(disallowed.join('\n'), new RegExp(toCodesurfMcpToolName(tool)))
    }
    assert.ok(disallowed.includes(toCodesurfMcpToolName('browser_navigate')))
    assert.equal(getAuthoritativeNegotiatedPeerTools(peers, false), undefined)

    const selected = selectAuthorizedPeerObservations([
      { peerId: 'forged-peer', context: { sentinel: 'FORGED-PEER-SYSTEM-SENTINEL' } },
      { peerId: 'unconnected-browser', context: { sentinel: 'UNCONNECTED-SENTINEL' } },
      { peerId: 'peer-chat', context: { sentinel: 'CONNECTED-UNTRUSTED-SENTINEL' } },
    ], peers)
    assert.equal(selected.length, 1)
    assert.equal((selected[0] as { peerId: string }).peerId, 'peer-chat')
  })

  test('authorized peer descriptions remain user-suffix data, never system context', () => {
    const peers = resolveAuthoritativeCanvasPeers(canvas, 'caller-chat')
    const rendered = buildUntrustedPeerObservationContext([
      { peerId: 'peer-chat', context: { note: 'CONNECTED-UNTRUSTED-SENTINEL' } },
      { peerId: 'forged-peer', context: { note: 'FORGED-PEER-SYSTEM-SENTINEL' } },
    ], peers)
    assert.match(rendered ?? '', /CONNECTED-UNTRUSTED-SENTINEL/)
    assert.doesNotMatch(rendered ?? '', /FORGED-PEER-SYSTEM-SENTINEL/)

    const composed = composeChatContext({ room: rendered })
    assert.doesNotMatch(composed.systemPrompt ?? '', /CONNECTED-UNTRUSTED-SENTINEL/)
    assert.match(composed.userSuffix ?? '', /CONNECTED-UNTRUSTED-SENTINEL/)
  })

  test('peer bridge requires a live connection and target tile tool capability', () => {
    const principal = { kind: 'tile' as const, workspaceId: 'workspace-a', tileId: 'caller-chat' }
    assert.deepEqual(authorizePeerBridgeTarget({
      principal,
      workspaceId: 'workspace-a',
      targetTileId: 'peer-terminal',
      toolName: 'terminal_send_input',
      canvas,
    }), { ok: true, tileType: 'terminal' })
    assert.deepEqual(authorizePeerBridgeTarget({
      principal,
      workspaceId: 'workspace-a',
      targetTileId: 'peer-chat',
      toolName: 'chat_send_message',
      canvas,
    }), { ok: true, tileType: 'chat' })
    assert.deepEqual(authorizePeerBridgeTarget({
      principal,
      workspaceId: 'workspace-a',
      targetTileId: 'peer-note',
      toolName: 'note_read_content',
      canvas,
    }), { ok: true, tileType: 'note' })

    const mismatched = authorizePeerBridgeTarget({
      principal,
      workspaceId: 'workspace-a',
      targetTileId: 'peer-chat',
      toolName: 'terminal_send_input',
      canvas,
    })
    assert.equal(mismatched.ok, false)
    assert.match('error' in mismatched ? mismatched.error : '', /do not expose/i)

    const unconnected = authorizePeerBridgeTarget({
      principal,
      workspaceId: 'workspace-a',
      targetTileId: 'unconnected-browser',
      toolName: 'browser_navigate',
      canvas,
    })
    assert.equal(unconnected.ok, false)
    assert.match('error' in unconnected ? unconnected.error : '', /not a current connected peer/i)
  })

  test('forged workspace, self-target, and missing targets fail closed', () => {
    const principal = { kind: 'tile' as const, workspaceId: 'workspace-a', tileId: 'caller-chat' }
    for (const result of [
      authorizePeerBridgeTarget({ principal, workspaceId: 'workspace-b', targetTileId: 'peer-terminal', toolName: 'terminal_send_input', canvas }),
      authorizePeerBridgeTarget({ principal, workspaceId: 'workspace-a', targetTileId: 'caller-chat', toolName: 'chat_send_message', canvas }),
      authorizePeerBridgeTarget({ principal: { kind: 'global' }, workspaceId: 'workspace-a', targetTileId: 'missing', toolName: 'chat_send_message', canvas }),
    ]) {
      assert.equal(result.ok, false)
    }
  })
})

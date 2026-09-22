import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  getTileNodeTools,
  buildPeerCommandPayload,
  getDisconnectedPeerBridgeMcpToolNames,
  getPeerBridgeNodeTools,
  normalizeNodeToolName,
} from '../src/shared/nodeTools.ts'

describe('node peer bridge tools', () => {
  test('keeps only disconnected peer bridge tools in the Claude disallow list', () => {
    const disallowed = getDisconnectedPeerBridgeMcpToolNames([
      'browser_navigate',
      'tool:browser_reload',
      'mcp__codesurf__chat_send_message',
    ])

    expect(disallowed).not.toContain('mcp__codesurf__browser_navigate')
    expect(disallowed).not.toContain('mcp__codesurf__browser_reload')
    expect(disallowed).not.toContain('mcp__codesurf__chat_send_message')
    expect(disallowed).not.toContain('mcp__codesurf__tile_context_get')
    expect(disallowed).toContain('mcp__codesurf__terminal_send_input')
  })

  test('does not classify universal context tools as peer bridge tools', () => {
    const peerBridgeTools = getPeerBridgeNodeTools().map(tool => tool.name)

    expect(peerBridgeTools).not.toContain('tile_context_get')
    expect(peerBridgeTools).not.toContain('tile_context_set')
  })

  test('normalizes capability and MCP tool prefixes for comparison', () => {
    expect(normalizeNodeToolName('tool:browser_navigate')).toBe('browser_navigate')
    expect(normalizeNodeToolName('mcp__codesurf__browser_navigate')).toBe('browser_navigate')
  })

  test('peer command payloads include the explicit target fields chat tiles require', () => {
    expect(buildPeerCommandPayload('chat-1', 'chat_send_message', { message: 'hello' })).toEqual({
      tileId: 'chat-1',
      cardId: 'chat-1',
      command: 'chat_send_message',
      message: 'hello',
    })
  })

  test('image tiles expose editing tools for connected agents', () => {
    const imageTools = getTileNodeTools('image').map(tool => tool.name)

    expect(imageTools).toContain('image_annotate')
    expect(imageTools).toContain('image_edit_request')
    expect(imageTools).toContain('image_generate_variation')
    expect(imageTools).toContain('image_replace_source')
  })
})

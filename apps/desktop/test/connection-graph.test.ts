import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  addAssociatedConnectionGroups,
  cascadeConnectionGraph,
  type ConnectionGraphLink,
  type ConnectionGraphState,
  type ConnectionGraphTile,
} from '../src/shared/connectionGraph.ts'

type TestTileType = 'chat' | 'files' | 'file' | 'terminal'

const tiles: ConnectionGraphTile<TestTileType>[] = [
  { id: 'chat-1', type: 'chat' },
  { id: 'files-1', type: 'files' },
  { id: 'task-1', type: 'file' },
  { id: 'term-1', type: 'terminal' },
]

const capabilities = new Map<string, string[]>([
  ['chat-1', ['tool:chat_send_message']],
  ['files-1', ['tool:file_read', 'tool:file_search']],
  ['task-1', ['file', 'reference']],
  ['term-1', ['tool:terminal_send_input']],
])

function link(peerId: string, peerType: TestTileType, distance = 20): ConnectionGraphLink<TestTileType> {
  return {
    peerId,
    peerType,
    distance,
    route: [{ x: 0, y: 0 }, { x: distance, y: 0 }],
    capabilities: capabilities.get(peerId) ?? [],
    lastSeen: 123,
  }
}

function graph(entries: Array<[string, ConnectionGraphLink<TestTileType>[]]>): ConnectionGraphState<TestTileType> {
  return {
    connectedTileIds: new Set(entries.flatMap(([tileId, links]) => [tileId, ...links.map(item => item.peerId)])),
    byTile: new Map(entries),
  }
}

function cascade(input: ConnectionGraphState<TestTileType>): ConnectionGraphState<TestTileType> {
  return cascadeConnectionGraph(input, tiles, {
    now: () => 456,
    resolveCapabilities: (_sourceTileId, targetTileId) => capabilities.get(targetTileId) ?? [],
    resolveRoute: (_sourceTileId, _targetTileId, via) => ({
      route: via.route,
      distance: via.distance,
    }),
  })
}

function associate(input: ConnectionGraphState<TestTileType>, groups: string[][]): ConnectionGraphState<TestTileType> {
  return addAssociatedConnectionGroups(input, tiles, groups, {
    now: () => 456,
    resolveCapabilities: (_sourceTileId, targetTileId) => capabilities.get(targetTileId) ?? [],
    resolveRoute: () => ({ route: [], distance: 0 }),
  })
}

function peerIds(state: ConnectionGraphState<TestTileType>, tileId: string): string[] {
  return (state.byTile.get(tileId) ?? []).map(item => item.peerId).sort()
}

describe('connection graph cascade', () => {
  test('treats a one-sided direct edge as bidirectional for peer discovery', () => {
    const result = cascade(graph([
      ['chat-1', [link('files-1', 'files')]],
    ]))

    expect(peerIds(result, 'chat-1')).toEqual(['files-1'])
    expect(peerIds(result, 'files-1')).toEqual(['chat-1'])
  })

  test('cascades reachable peers both ways through a connected chain', () => {
    const result = cascade(graph([
      ['chat-1', [link('files-1', 'files')]],
      ['files-1', [link('chat-1', 'chat'), link('task-1', 'file')]],
      ['task-1', [link('files-1', 'files')]],
    ]))

    expect(peerIds(result, 'chat-1')).toEqual(['files-1', 'task-1'])
    expect(peerIds(result, 'files-1')).toEqual(['chat-1', 'task-1'])
    expect(peerIds(result, 'task-1')).toEqual(['chat-1', 'files-1'])
    expect(result.byTile.get('chat-1')?.find(item => item.peerId === 'task-1')?.capabilities).toEqual(['file', 'reference'])
    expect(result.byTile.get('task-1')?.find(item => item.peerId === 'chat-1')?.capabilities).toEqual(['tool:chat_send_message'])
  })

  test('preserves direct link payloads and only synthesizes missing reachable peers', () => {
    const direct = link('files-1', 'files', 7)
    direct.capabilities = ['direct-only']

    const result = cascade(graph([
      ['chat-1', [direct]],
      ['files-1', [link('chat-1', 'chat'), link('term-1', 'terminal')]],
      ['term-1', [link('files-1', 'files')]],
    ]))

    expect(result.byTile.get('chat-1')?.find(item => item.peerId === 'files-1')?.capabilities).toEqual(['direct-only'])
    expect(result.byTile.get('chat-1')?.find(item => item.peerId === 'term-1')?.capabilities).toEqual(['tool:terminal_send_input'])
  })

  test('does not invent peers after all connections are removed', () => {
    const result = cascade({ connectedTileIds: new Set(), byTile: new Map() })

    expect(result.connectedTileIds.size).toBe(0)
    expect(result.byTile.size).toBe(0)
  })

  test('connects fullscreen or panel peers by association before cascading', () => {
    const associated = associate(
      graph([
        ['chat-1', [link('files-1', 'files')]],
        ['files-1', [link('chat-1', 'chat')]],
      ]),
      [['files-1', 'task-1']],
    )
    const result = cascade(associated)

    expect(peerIds(result, 'chat-1')).toEqual(['files-1', 'task-1'])
    expect(peerIds(result, 'task-1')).toEqual(['chat-1', 'files-1'])
    expect(result.byTile.get('files-1')?.find(item => item.peerId === 'task-1')?.distance).toBe(0)
  })

  test('does not duplicate existing direct links when adding association groups', () => {
    const input = graph([
      ['files-1', [link('task-1', 'file', 11)]],
      ['task-1', [link('files-1', 'files', 11)]],
    ])
    const result = associate(input, [['files-1', 'task-1']])

    expect(result.byTile.get('files-1')?.filter(item => item.peerId === 'task-1').length).toBe(1)
    expect(result.byTile.get('task-1')?.filter(item => item.peerId === 'files-1').length).toBe(1)
  })
})

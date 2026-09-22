export type ConnectionGraphTile<TType extends string = string> = {
  id: string
  type: TType
}

export type ConnectionGraphLink<TType extends string = string> = {
  peerId: string
  peerType: TType
  distance: number
  route: { x: number; y: number }[]
  capabilities: string[]
  lastSeen: number
}

export type ConnectionGraphState<TType extends string = string> = {
  connectedTileIds: Set<string>
  byTile: Map<string, ConnectionGraphLink<TType>[]>
}

export type CascadeConnectionGraphOptions<TType extends string = string> = {
  resolveCapabilities: (sourceTileId: string, targetTileId: string) => string[]
  resolveRoute?: (sourceTileId: string, targetTileId: string, via: ConnectionGraphLink<TType>) => {
    route: { x: number; y: number }[]
    distance: number
  } | null
  now?: () => number
}

function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}

export function cascadeConnectionGraph<TType extends string = string>(
  graph: ConnectionGraphState<TType>,
  tileList: ConnectionGraphTile<TType>[],
  options: CascadeConnectionGraphOptions<TType>,
): ConnectionGraphState<TType> {
  const tileMap = new Map(tileList.map(tile => [tile.id, tile]))
  const connectedTileIds = new Set(graph.connectedTileIds)
  const byTile = new Map<string, ConnectionGraphLink<TType>[]>()
  const adjacency = new Map<string, ConnectionGraphLink<TType>[]>()
  const now = options.now ?? Date.now

  for (const [tileId, links] of graph.byTile) {
    byTile.set(tileId, [...links])
    const nextLinks = adjacency.get(tileId) ?? []
    nextLinks.push(...links)
    adjacency.set(tileId, nextLinks)

    for (const link of links) {
      const sourceTile = tileMap.get(tileId)
      const peerTile = tileMap.get(link.peerId)
      if (!sourceTile || !peerTile) continue

      const reverseLinks = adjacency.get(link.peerId) ?? []
      if (!reverseLinks.some(existing => existing.peerId === tileId)) {
        reverseLinks.push({
          peerId: tileId,
          peerType: sourceTile.type,
          distance: link.distance,
          route: [...link.route].reverse(),
          capabilities: uniq(options.resolveCapabilities(link.peerId, tileId)),
          lastSeen: link.lastSeen,
        })
      }
      adjacency.set(link.peerId, reverseLinks)
    }
  }

  for (const sourceTile of tileList) {
    const sourceLinks = adjacency.get(sourceTile.id) ?? []
    if (sourceLinks.length === 0) continue

    const visited = new Set<string>([sourceTile.id])
    const queue: Array<{ tileId: string; depth: number; via: ConnectionGraphLink<TType> }> = sourceLinks.map(link => ({
      tileId: link.peerId,
      depth: 1,
      via: link,
    }))

    while (queue.length > 0) {
      const current = queue.shift()!
      if (visited.has(current.tileId)) continue
      visited.add(current.tileId)

      const targetTile = tileMap.get(current.tileId)
      if (targetTile) {
        connectedTileIds.add(sourceTile.id)
        connectedTileIds.add(targetTile.id)

        const existing = byTile.get(sourceTile.id) ?? []
        const alreadyLinked = existing.some(link => link.peerId === targetTile.id)
        if (!alreadyLinked) {
          const resolved = options.resolveRoute?.(sourceTile.id, targetTile.id, current.via)
          existing.push({
            peerId: targetTile.id,
            peerType: targetTile.type,
            distance: (current.depth * 100000) + (resolved?.distance ?? current.via.distance),
            route: resolved?.route ?? current.via.route,
            capabilities: uniq(options.resolveCapabilities(sourceTile.id, targetTile.id)),
            lastSeen: now(),
          })
          byTile.set(sourceTile.id, existing)
        }
      }

      const nextLinks = adjacency.get(current.tileId) ?? []
      for (const next of nextLinks) {
        if (!visited.has(next.peerId)) {
          queue.push({ tileId: next.peerId, depth: current.depth + 1, via: next })
        }
      }
    }
  }

  return { connectedTileIds, byTile }
}

export type AssociatedConnectionGroupOptions = {
  resolveCapabilities: (sourceTileId: string, targetTileId: string) => string[]
  resolveRoute?: (sourceTileId: string, targetTileId: string) => {
    route: { x: number; y: number }[]
    distance: number
  } | null
  now?: () => number
}

export function addAssociatedConnectionGroups<TType extends string = string>(
  graph: ConnectionGraphState<TType>,
  tileList: ConnectionGraphTile<TType>[],
  associatedTileGroups: string[][],
  options: AssociatedConnectionGroupOptions,
): ConnectionGraphState<TType> {
  const tileMap = new Map(tileList.map(tile => [tile.id, tile]))
  const connectedTileIds = new Set(graph.connectedTileIds)
  const byTile = new Map<string, ConnectionGraphLink<TType>[]>()
  const now = options.now ?? Date.now

  for (const [tileId, links] of graph.byTile) {
    byTile.set(tileId, [...links])
  }

  const addLink = (sourceTileId: string, targetTileId: string): void => {
    const sourceTile = tileMap.get(sourceTileId)
    const targetTile = tileMap.get(targetTileId)
    if (!sourceTile || !targetTile || sourceTile.id === targetTile.id) return

    const existing = byTile.get(sourceTile.id) ?? []
    if (existing.some(link => link.peerId === targetTile.id)) return

    const resolved = options.resolveRoute?.(sourceTile.id, targetTile.id)
    existing.push({
      peerId: targetTile.id,
      peerType: targetTile.type,
      distance: resolved?.distance ?? 0,
      route: resolved?.route ?? [],
      capabilities: uniq(options.resolveCapabilities(sourceTile.id, targetTile.id)),
      lastSeen: now(),
    })
    byTile.set(sourceTile.id, existing)
    connectedTileIds.add(sourceTile.id)
    connectedTileIds.add(targetTile.id)
  }

  for (const group of associatedTileGroups) {
    const ids = uniq(group.filter(tileId => tileMap.has(tileId)))
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        addLink(ids[i], ids[j])
        addLink(ids[j], ids[i])
      }
    }
  }

  return { connectedTileIds, byTile }
}

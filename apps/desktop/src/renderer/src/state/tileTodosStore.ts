/**
 * tileTodosStore
 * ---------------
 *
 * A minimal pub/sub store that tracks the most recent `TodoWrite` tool
 * output per chat tile so UI chrome outside the tile (e.g. the panel tab
 * bar) can surface the agent's current todo list without drilling into
 * the tile's internal state.
 *
 * A chat tile calls `setTileTodos(tileId, todos)` whenever a new
 * `TodoWrite` tool_use is observed in the active session. Consumers read
 * with the `useTileTodos(tileId)` hook and re-render on change.
 *
 * State is module-scoped (renderer-only, ephemeral). Losing it on reload
 * is fine: the source of truth lives in the chat message log and gets
 * re-derived the next time `TodoWrite` is parsed.
 */

import { useEffect, useState } from 'react'

export interface TileTodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed' | string
  activeForm?: string
}

type Listener = (todos: TileTodoItem[] | null) => void

const todosByTileId: Map<string, TileTodoItem[]> = new Map()
const listenersByTileId: Map<string, Set<Listener>> = new Map()

function shallowEqualTodos(a: TileTodoItem[] | null, b: TileTodoItem[] | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.content !== y.content || x.status !== y.status || x.activeForm !== y.activeForm) return false
  }
  return true
}

export function setTileTodos(tileId: string, todos: TileTodoItem[] | null): void {
  const existing = todosByTileId.get(tileId) ?? null
  if (shallowEqualTodos(existing, todos)) return
  if (todos && todos.length > 0) {
    todosByTileId.set(tileId, todos)
  } else {
    todosByTileId.delete(tileId)
  }
  const listeners = listenersByTileId.get(tileId)
  if (listeners) {
    for (const l of listeners) l(todos && todos.length > 0 ? todos : null)
  }
}

export function getTileTodos(tileId: string): TileTodoItem[] | null {
  return todosByTileId.get(tileId) ?? null
}

export function clearTileTodos(tileId: string): void {
  setTileTodos(tileId, null)
}

export function useTileTodos(tileId: string | null | undefined): TileTodoItem[] | null {
  const [snapshot, setSnapshot] = useState<TileTodoItem[] | null>(() =>
    tileId ? getTileTodos(tileId) : null
  )
  useEffect(() => {
    if (!tileId) {
      setSnapshot(null)
      return
    }
    setSnapshot(getTileTodos(tileId))
    let listeners = listenersByTileId.get(tileId)
    if (!listeners) {
      listeners = new Set()
      listenersByTileId.set(tileId, listeners)
    }
    const cb: Listener = (todos) => setSnapshot(todos)
    listeners.add(cb)
    return () => {
      const l = listenersByTileId.get(tileId)
      if (!l) return
      l.delete(cb)
      if (l.size === 0) listenersByTileId.delete(tileId)
    }
  }, [tileId])
  return snapshot
}

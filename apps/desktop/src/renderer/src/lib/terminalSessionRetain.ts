/**
 * Refcount terminal PTY attachments so a tile can be mounted in more than one
 * React tree (fullscreen panel + canvas layout group) without detach killing
 * the live session on the first unmount.
 *
 * Release is deferred to the next microtask so a same-commit remount
 * (canvas tile hidden, layout-group + fullscreen mount) does not drop the
 * count to zero and detach before the new instances retain.
 */

export type TerminalSessionLease = {
  retain: (tileId: string) => void
  release: (tileId: string) => void
  count: (tileId: string) => number
  flush: () => void
}

export function createTerminalSessionLease(options: {
  detach: (tileId: string) => void
  schedule?: (callback: () => void) => void
}): TerminalSessionLease {
  const counts = new Map<string, number>()
  const pending = new Set<string>()
  const schedule = options.schedule ?? (callback => queueMicrotask(callback))

  const flushTile = (tileId: string): void => {
    pending.delete(tileId)
    if ((counts.get(tileId) ?? 0) > 0) return
    counts.delete(tileId)
    options.detach(tileId)
  }

  return {
    retain(tileId: string) {
      if (!tileId) return
      counts.set(tileId, (counts.get(tileId) ?? 0) + 1)
      pending.delete(tileId)
    },
    release(tileId: string) {
      if (!tileId) return
      const next = (counts.get(tileId) ?? 0) - 1
      if (next > 0) {
        counts.set(tileId, next)
        return
      }
      counts.delete(tileId)
      if (pending.has(tileId)) return
      pending.add(tileId)
      schedule(() => flushTile(tileId))
    },
    count(tileId: string) {
      return counts.get(tileId) ?? 0
    },
    flush() {
      for (const tileId of [...pending]) flushTile(tileId)
    },
  }
}

export const terminalSessionLease = createTerminalSessionLease({
  detach(tileId) {
    const detach = window.electron?.terminal?.detach?.(tileId)
    void detach?.catch(() => {})
  },
})

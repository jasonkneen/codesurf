import { useState, useRef, useCallback, type Dispatch, type SetStateAction } from 'react'

/**
 * A useState replacement that also maintains a ref synced with the latest value.
 * Eliminates the need for separate useEffect-based ref mirroring.
 *
 * Returns [value, setter, ref] where:
 * - value is the current state (same as useState)
 * - setter updates both state and ref synchronously
 * - ref always holds the latest value without stale closure issues
 *
 * Usage:
 *   const [tiles, setTiles, tilesRef] = useLatestState<TileState[]>([])
 *   // tilesRef.current is always up-to-date, no useEffect needed
 */
export function useLatestState<T>(
  initialValue: T | (() => T),
): [T, Dispatch<SetStateAction<T>>, React.MutableRefObject<T>] {
  const [value, setValue] = useState(initialValue)
  const resolved = typeof initialValue === 'function'
    ? (initialValue as () => T)()
    : initialValue
  const ref = useRef<T>(value ?? resolved)

  const setLatest = useCallback((action: SetStateAction<T>) => {
    setValue(prev => {
      const next = typeof action === 'function'
        ? (action as (prev: T) => T)(prev)
        : action
      ref.current = next
      return next
    })
  }, [])

  return [value, setLatest, ref]
}

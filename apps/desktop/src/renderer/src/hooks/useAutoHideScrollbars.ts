import { useEffect } from 'react'

const SCROLLBAR_VISIBLE_CLASS = 'scrollbar-visible'
const SCROLLBAR_HIDE_DELAY_MS = 900

function hasScrollableOverflow(element: HTMLElement): boolean {
  return element.scrollHeight > element.clientHeight + 1
    || element.scrollWidth > element.clientWidth + 1
}

export function useAutoHideScrollbars(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return

    const hideTimers = new Map<HTMLElement, number>()

    const clearHideTimer = (element: HTMLElement): void => {
      const timeoutId = hideTimers.get(element)
      if (timeoutId == null) return
      window.clearTimeout(timeoutId)
      hideTimers.delete(element)
    }

    const showScrollbar = (element: HTMLElement): void => {
      if (!hasScrollableOverflow(element)) return

      element.classList.add(SCROLLBAR_VISIBLE_CLASS)
      clearHideTimer(element)

      const timeoutId = window.setTimeout(() => {
        hideTimers.delete(element)
        if (!element.isConnected) return
        element.classList.remove(SCROLLBAR_VISIBLE_CLASS)
      }, SCROLLBAR_HIDE_DELAY_MS)

      hideTimers.set(element, timeoutId)
    }

    const handleScroll = (event: Event): void => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (target.dataset.scrollbarAutohide === 'off') return
      showScrollbar(target)
    }

    document.addEventListener('scroll', handleScroll, true)

    return () => {
      document.removeEventListener('scroll', handleScroll, true)
      for (const [element, timeoutId] of hideTimers) {
        window.clearTimeout(timeoutId)
        if (element.isConnected) {
          element.classList.remove(SCROLLBAR_VISIBLE_CLASS)
        }
      }
      hideTimers.clear()
    }
  }, [])
}

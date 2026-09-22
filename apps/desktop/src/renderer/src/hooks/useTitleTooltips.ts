/**
 * Global title-attribute tooltips.
 *
 * Electron transparent windows with `titleBarStyle: 'hiddenInset'` suppress
 * native title-attribute tooltips. This hook listens for mouseenter on any
 * element with a `title` attribute, temporarily strips it (so the native
 * tooltip doesn't race), and renders a styled tooltip instead.
 *
 * Call once at the app root — no per-component changes needed.
 */

import { useEffect } from 'react'

const TOOLTIP_ID = '__global-title-tooltip'
const SHOW_DELAY = 400

let timer: ReturnType<typeof setTimeout> | null = null
let currentTarget: HTMLElement | null = null
let savedTitle = ''

function getOrCreateTooltip(): HTMLDivElement {
  let el = document.getElementById(TOOLTIP_ID) as HTMLDivElement | null
  if (el) return el

  el = document.createElement('div')
  el.id = TOOLTIP_ID
  el.style.cssText = `
    position: fixed;
    z-index: 999999;
    pointer-events: none;
    padding: 3px 7px;
    border-radius: 4px;
    font-size: 11px;
    line-height: 1.4;
    white-space: nowrap;
    opacity: 0;
    transition: opacity 0.12s ease;
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
  `
  document.body.appendChild(el)
  return el
}

function applyThemeColors(el: HTMLDivElement): void {
  // Read CSS variables from :root to match the app theme
  const style = getComputedStyle(document.documentElement)
  const bg = style.getPropertyValue('--tooltip-bg').trim()
  const fg = style.getPropertyValue('--tooltip-fg').trim()
  const border = style.getPropertyValue('--tooltip-border').trim()
  const shadow = style.getPropertyValue('--tooltip-shadow').trim()

  el.style.background = bg || 'rgba(30, 33, 40, 0.96)'
  el.style.color = fg || '#c9d1d9'
  el.style.border = `1px solid ${border || 'rgba(255,255,255,0.1)'}`
  el.style.boxShadow = shadow || '0 2px 8px rgba(0,0,0,0.4)'
}

function show(target: HTMLElement): void {
  const title = target.getAttribute('title') || ''
  if (!title.trim()) return

  // Strip the native title so the OS tooltip doesn't appear
  savedTitle = title
  target.removeAttribute('title')
  currentTarget = target

  const tip = getOrCreateTooltip()
  tip.textContent = title
  applyThemeColors(tip)

  // Position relative to the target
  const rect = target.getBoundingClientRect()
  tip.style.opacity = '0'
  tip.style.display = 'block'

  // Measure tooltip dimensions
  const tipRect = tip.getBoundingClientRect()

  // Default: below and centered
  let left = rect.left + rect.width / 2 - tipRect.width / 2
  let top = rect.bottom + 5

  // If it would go off the bottom, show above
  if (top + tipRect.height > window.innerHeight - 8) {
    top = rect.top - tipRect.height - 5
  }

  // Clamp horizontally
  left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8))

  tip.style.left = `${left}px`
  tip.style.top = `${top}px`
  tip.style.opacity = '1'
}

function hide(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }

  // Restore the title attribute
  if (currentTarget && savedTitle) {
    currentTarget.setAttribute('title', savedTitle)
  }
  currentTarget = null
  savedTitle = ''

  const tip = document.getElementById(TOOLTIP_ID)
  if (tip) tip.style.opacity = '0'
}

function onMouseEnter(e: MouseEvent): void {
  const target = (e.target as HTMLElement)?.closest?.('[title]') as HTMLElement | null
  if (!target || !target.getAttribute('title')?.trim()) return

  hide()
  timer = setTimeout(() => show(target), SHOW_DELAY)
}

function onMouseLeave(e: MouseEvent): void {
  if (!currentTarget) return
  const from = e.target as Node | null
  const to = e.relatedTarget as Node | null
  if (!from || !currentTarget.contains(from)) return
  if (!to || !currentTarget.contains(to)) hide()
}

function onScroll(): void {
  hide()
}

export function useTitleTooltips(): void {
  useEffect(() => {
    document.addEventListener('mouseover', onMouseEnter, true)
    document.addEventListener('mouseout', onMouseLeave, true)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('mousedown', hide, true)

    return () => {
      hide()
      document.removeEventListener('mouseover', onMouseEnter, true)
      document.removeEventListener('mouseout', onMouseLeave, true)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('mousedown', hide, true)
      const tip = document.getElementById(TOOLTIP_ID)
      if (tip) tip.remove()
    }
  }, [])
}

import { useCallback, useRef, type RefObject } from 'react'

export type UseCanvasGlowOptions = {
  canvasRef: RefObject<HTMLDivElement | null>
  canvasGlowEnabled: boolean
  canvasGlowRadius: number
  viewportZoom: number
}

export function useCanvasGlow(options: UseCanvasGlowOptions) {
  const { canvasRef, canvasGlowEnabled, canvasGlowRadius, viewportZoom } = options

  const dotGlowSmallRef = useRef<HTMLDivElement>(null)
  const dotGlowLargeRef = useRef<HTMLDivElement>(null)
  const discoveryGlowRef = useRef<HTMLDivElement>(null)
  const canvasGlowRafRef = useRef<number | null>(null)
  const canvasGlowPointRef = useRef<{ clientX: number, clientY: number } | null>(null)

  const cursorGlowBrightnessScale = 1 + ((viewportZoom - 1) / 0.2) * 0.1
  const cursorGlowOpacity = Math.max(0, Math.min(1, cursorGlowBrightnessScale))
  const cursorGlowFilterBrightness = Math.max(1, cursorGlowBrightnessScale)

  const hideCanvasGlow = useCallback(() => {
    if (canvasGlowRafRef.current !== null) {
      cancelAnimationFrame(canvasGlowRafRef.current)
      canvasGlowRafRef.current = null
    }
    canvasGlowPointRef.current = null
    if (dotGlowSmallRef.current) {
      dotGlowSmallRef.current.style.opacity = '0'
      dotGlowSmallRef.current.style.filter = 'brightness(1)'
    }
    if (dotGlowLargeRef.current) {
      dotGlowLargeRef.current.style.opacity = '0'
      dotGlowLargeRef.current.style.filter = 'brightness(1)'
    }
    if (discoveryGlowRef.current) discoveryGlowRef.current.style.opacity = '0'
  }, [])

  const updateCanvasGlow = useCallback((clientX: number, clientY: number) => {
    if (!canvasGlowEnabled) return
    canvasGlowPointRef.current = { clientX, clientY }
    if (canvasGlowRafRef.current !== null) return
    canvasGlowRafRef.current = requestAnimationFrame(() => {
      canvasGlowRafRef.current = null
      const rect = canvasRef.current?.getBoundingClientRect()
      const point = canvasGlowPointRef.current
      if (!rect || !point || !dotGlowSmallRef.current || !dotGlowLargeRef.current) return
      const x = point.clientX - rect.left
      const y = point.clientY - rect.top
      const visible = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height
      if (!visible) {
        hideCanvasGlow()
        return
      }
      const innerGlowRadius = Math.round(canvasGlowRadius * 0.5)
      const mask = `radial-gradient(circle at ${x}px ${y}px, rgba(0,0,0,1) 0px, rgba(0,0,0,1) ${innerGlowRadius}px, rgba(0,0,0,0) ${canvasGlowRadius}px)`
      dotGlowSmallRef.current.style.opacity = String(cursorGlowOpacity)
      dotGlowLargeRef.current.style.opacity = String(cursorGlowOpacity)
      dotGlowSmallRef.current.style.filter = `brightness(${cursorGlowFilterBrightness})`
      dotGlowLargeRef.current.style.filter = `brightness(${cursorGlowFilterBrightness})`
      dotGlowSmallRef.current.style.maskImage = mask
      dotGlowSmallRef.current.style.webkitMaskImage = mask
      dotGlowLargeRef.current.style.maskImage = mask
      dotGlowLargeRef.current.style.webkitMaskImage = mask
      if (discoveryGlowRef.current) {
        discoveryGlowRef.current.style.opacity = '1'
        discoveryGlowRef.current.style.maskImage = mask
        discoveryGlowRef.current.style.webkitMaskImage = mask
      }
    })
  }, [
    canvasGlowEnabled,
    canvasGlowRadius,
    canvasRef,
    cursorGlowFilterBrightness,
    cursorGlowOpacity,
    hideCanvasGlow,
  ])

  return {
    dotGlowSmallRef,
    dotGlowLargeRef,
    discoveryGlowRef,
    hideCanvasGlow,
    updateCanvasGlow,
  }
}
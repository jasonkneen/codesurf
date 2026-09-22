import { useRef, useEffect, useCallback } from 'react'
import type { TileState } from '../../../shared/types'
import { useTheme } from '../ThemeContext'
import { parseColor } from '../colorMath'

/** Convert a parseable colour string + alpha to an `rgba(...)` literal usable
 *  by Canvas2D. Returns the original input unchanged if parsing fails. */
function withAlpha(input: string, alpha: number): string {
  const parsed = parseColor(input)
  if (!parsed) return input
  const { r, g, b } = parsed.rgba
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

interface Props {
  tiles: TileState[]
  viewport: { tx: number; ty: number; zoom: number }
  canvasSize: { w: number; h: number }
  onPan: (tx: number, ty: number) => void
}

const TILE_COLORS: Record<string, string> = {
  terminal: '#4a9eff',
  code:     '#6db33f',
  note:     '#e2c08d',
  image:    '#e67e22',
  kanban:   '#c586c0',
  browser:  '#3fb950',
}

const W = 160
const H = 100
const PAD = 20

type MinimapTransform = {
  minX: number
  minY: number
  scale: number
  offX: number
  offY: number
}

function getBounds(tiles: TileState[]) {
  if (tiles.length === 0) return { minX: 0, minY: 0, maxX: 1000, maxY: 600 }
  const minX = Math.min(...tiles.map(t => t.x)) - PAD
  const minY = Math.min(...tiles.map(t => t.y)) - PAD
  const maxX = Math.max(...tiles.map(t => t.x + t.width)) + PAD
  const maxY = Math.max(...tiles.map(t => t.y + t.height)) + PAD
  return { minX, minY, maxX, maxY }
}

function getTransform(tiles: TileState[]): MinimapTransform {
  const { minX, minY, maxX, maxY } = getBounds(tiles)
  const worldW = maxX - minX
  const worldH = maxY - minY
  const scale = Math.min(W / worldW, H / worldH) * 0.9
  const offX = (W - worldW * scale) / 2 - minX * scale
  const offY = (H - worldH * scale) / 2 - minY * scale
  return { minX, minY, scale, offX, offY }
}

function drawTilesLayer(ctx: CanvasRenderingContext2D, tiles: TileState[], transform: MinimapTransform) {
  const { scale, offX, offY } = transform
  ctx.clearRect(0, 0, W, H)
  for (const tile of tiles) {
    const x = tile.x * scale + offX
    const y = tile.y * scale + offY
    const w = Math.max(2, tile.width * scale)
    const h = Math.max(2, tile.height * scale)
    ctx.fillStyle = TILE_COLORS[tile.type] + '88'
    ctx.strokeStyle = TILE_COLORS[tile.type] + 'cc'
    ctx.lineWidth = 0.5
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, 1)
    ctx.fill()
    ctx.stroke()
  }
}

export function Minimap({ tiles, viewport, canvasSize, onPan }: Props): JSX.Element | null {
  const theme = useTheme()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const tilesLayerRef = useRef<HTMLCanvasElement | null>(null)
  const transformRef = useRef<MinimapTransform | null>(null)
  const viewportRafRef = useRef<number | null>(null)
  const dragging = useRef(false)

  const getViewportColor = useCallback(() => {
    const css = getComputedStyle(document.documentElement)
    return css.getPropertyValue('--cs-th-text-primary').trim() || theme.text.primary
  }, [theme.text.primary])

  const paintTilesLayer = useCallback(() => {
    const layer = tilesLayerRef.current
    if (!layer) return
    const ctx = layer.getContext('2d')
    if (!ctx) return
    const transform = getTransform(tiles)
    transformRef.current = transform
    const dpr = window.devicePixelRatio || 1
    layer.width = W * dpr
    layer.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawTilesLayer(ctx, tiles, transform)
  }, [tiles])

  const paintViewport = useCallback(() => {
    const canvas = canvasRef.current
    const layer = tilesLayerRef.current
    const transform = transformRef.current
    if (!canvas || !layer || !transform) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.drawImage(layer, 0, 0, W, H)
    const { scale, offX, offY } = transform
    const vx = (-viewport.tx / viewport.zoom) * scale + offX
    const vy = (-viewport.ty / viewport.zoom) * scale + offY
    const vw = (canvasSize.w / viewport.zoom) * scale
    const vh = (canvasSize.h / viewport.zoom) * scale
    const viewportColor = getViewportColor()
    ctx.strokeStyle = withAlpha(viewportColor, 0.3)
    ctx.lineWidth = 1
    ctx.strokeRect(vx, vy, vw, vh)
    ctx.fillStyle = withAlpha(viewportColor, 0.04)
    ctx.fillRect(vx, vy, vw, vh)
  }, [canvasSize, getViewportColor, viewport])

  useEffect(() => {
    if (!tilesLayerRef.current) {
      tilesLayerRef.current = document.createElement('canvas')
    }
    paintTilesLayer()
  }, [paintTilesLayer])

  useEffect(() => {
    if (viewportRafRef.current !== null) cancelAnimationFrame(viewportRafRef.current)
    viewportRafRef.current = requestAnimationFrame(() => {
      viewportRafRef.current = null
      paintViewport()
    })
    return () => {
      if (viewportRafRef.current !== null) cancelAnimationFrame(viewportRafRef.current)
    }
  }, [paintViewport, viewport.tx, viewport.ty, viewport.zoom, canvasSize.w, canvasSize.h, theme.text.primary, tiles])

  const panTo = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    const transform = transformRef.current
    if (!canvas || !transform) return
    const rect = canvas.getBoundingClientRect()
    const mx = (clientX - rect.left) * (W / rect.width)
    const my = (clientY - rect.top) * (H / rect.height)
    const { scale, offX, offY } = transform
    const worldX = (mx - offX) / scale
    const worldY = (my - offY) / scale
    const newTx = canvasSize.w / 2 - worldX * viewport.zoom
    const newTy = canvasSize.h / 2 - worldY * viewport.zoom
    onPan(newTx, newTy)
  }, [canvasSize, onPan, viewport.zoom])

  if (tiles.length === 0) return null

  return (
    <div style={{
      position: 'absolute', bottom: 16, left: 16,
      background: `color-mix(in srgb, ${theme.surface.panel} 88%, transparent)`,
      border: `1px solid ${theme.border.subtle}`,
      borderRadius: 6,
      overflow: 'hidden',
      zIndex: 500,
      boxShadow: `0 4px 16px color-mix(in srgb, #000 40%, transparent)`,
      cursor: 'crosshair',
    }}>
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        style={{ display: 'block', width: W, height: H }}
        onMouseDown={e => { dragging.current = true; panTo(e.clientX, e.clientY) }}
        onMouseMove={e => { if (dragging.current) panTo(e.clientX, e.clientY) }}
        onMouseUp={() => { dragging.current = false }}
        onMouseLeave={() => { dragging.current = false }}
      />
    </div>
  )
}
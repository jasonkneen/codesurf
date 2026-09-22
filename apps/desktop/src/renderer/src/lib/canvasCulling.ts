// Pure viewport-culling / LOD geometry for the canvas. Electron-free so it can
// be unit tested under `node --test`.

export interface CullingViewport {
  tx: number
  ty: number
  zoom: number
}

export interface CullableTile {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Screen-pixel margin kept live around the visible viewport. Generous on
 * purpose: with imperative pan the culled set only refreshes on viewport
 * commits (throttled during a gesture), so tiles just outside the screen must
 * already be painting before they scroll in.
 */
export const CULL_MARGIN_PX = 600

/**
 * True when a tile (world coords) lies entirely outside the screen viewport
 * plus margin — i.e. its body can stop painting without any visible effect.
 */
export function isTileOffscreen(
  tile: CullableTile,
  viewport: CullingViewport,
  screenWidth: number,
  screenHeight: number,
  marginPx: number = CULL_MARGIN_PX,
): boolean {
  const left = tile.x * viewport.zoom + viewport.tx
  const top = tile.y * viewport.zoom + viewport.ty
  const right = left + tile.width * viewport.zoom
  const bottom = top + tile.height * viewport.zoom
  return (
    right < -marginPx ||
    bottom < -marginPx ||
    left > screenWidth + marginPx ||
    top > screenHeight + marginPx
  )
}

/**
 * Tile types whose bodies are expensive to keep painting at far-out zoom
 * (embedded editors, terminals, webviews, board layouts). Cheap visual tiles
 * (notes, images, media) keep their real bodies — they ARE the zoomed-out
 * visual. Extension tiles (`ext:*`) are webview-hosted, so they count as heavy.
 */
const HEAVY_TILE_TYPES = new Set(['terminal', 'code', 'browser', 'chat', 'kanban', 'files', 'file', 'customisation'])

export function isHeavyTileType(type: string): boolean {
  return HEAVY_TILE_TYPES.has(type) || type.startsWith('ext:')
}

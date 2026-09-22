/**
 * Re-export paint-rate policy for renderer imports.
 * Canonical implementation lives in shared/webview-paint-bridge.ts.
 */

export {
  frameRateForPaintActive,
  WEBVIEW_PAINT_ACTIVE_FPS,
  WEBVIEW_PAINT_CULLED_FPS,
} from '../../../shared/webview-paint-bridge.ts'

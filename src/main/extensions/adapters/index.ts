/**
 * Adapter registry — tries each adapter in order to auto-detect extension format.
 */

import type { ExtensionAdapter } from './types'
import { raycastAdapter } from './raycast'
import { piAdapter } from './pi'
import { openclawAdapter } from './openclaw'

export type { ExtensionAdapter }

/** Order matters — first match wins */
export const adapters: ExtensionAdapter[] = [
  raycastAdapter,
  piAdapter,
  openclawAdapter,
]

/**
 * Try to detect and convert a directory to a contex extension manifest
 * using one of the registered adapters.
 * Returns null if no adapter recognises the format.
 */
export async function tryAdaptExtension(dir: string) {
  for (const adapter of adapters) {
    try {
      if (await adapter.canLoad(dir)) {
        const manifest = await adapter.toManifest(dir)
        if (adapter.wrapEntry) {
          await adapter.wrapEntry(dir, manifest)
        }
        console.log(`[Extensions] Adapted ${dir} via ${adapter.name} adapter`)
        return manifest
      }
    } catch (err) {
      console.warn(`[Extensions] Adapter ${adapter.name} failed for ${dir}:`, err)
    }
  }
  return null
}

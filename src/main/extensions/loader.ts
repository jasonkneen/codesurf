/**
 * Power extension loader — safely requires and activates Node.js extensions.
 */

import { join } from 'path'
import type { ExtensionManifest } from '../../shared/types'
import type { ExtensionContext } from './context'

export async function loadPowerExtension(
  manifest: ExtensionManifest,
  ctx: ExtensionContext,
): Promise<(() => void) | null> {
  if (!manifest.main || !manifest._path) return null

  const entryPath = join(manifest._path, manifest.main)
  const prefix = `[Ext:${manifest.name}]`

  try {
    // Clear require cache so extensions can be hot-reloaded
    delete require.cache[require.resolve(entryPath)]
    const mod = require(entryPath)

    if (typeof mod.activate !== 'function') {
      console.warn(`${prefix} No activate() export found in ${entryPath}`)
      return null
    }

    console.log(`${prefix} Activating power extension...`)
    const result = await mod.activate(ctx)

    // activate() can return a cleanup function
    if (typeof result === 'function') {
      return () => {
        try {
          result()
          ctx.dispose()
        } catch (err) {
          console.error(`${prefix} Error during deactivation:`, err)
        }
      }
    }

    return () => ctx.dispose()
  } catch (err) {
    console.error(`${prefix} Failed to load power extension:`, err)
    return null
  }
}

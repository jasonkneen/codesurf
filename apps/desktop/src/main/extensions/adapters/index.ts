/**
 * Adapter registry — tries each adapter in order to auto-detect extension format.
 */

import type { ExtensionAdapter } from './types'
import { raycastAdapter } from './raycast'
import { piAdapter } from './pi'
import { openclawAdapter } from './openclaw'
import { log } from '../../utils/logger.ts'
import { assertValidExtensionId } from '../identity.ts'
import type { ExtensionManifest } from '../../../shared/types.ts'

const extLog = log.scope('Extensions')

export type { ExtensionAdapter }

/** Order matters — first match wins */
export const adapters: ExtensionAdapter[] = [
  raycastAdapter,
  piAdapter,
  openclawAdapter,
]

export interface AdaptedExtension {
  adapter: ExtensionAdapter
  manifest: ExtensionManifest
}

export function assertValidAdaptedManifest(
  manifest: ExtensionManifest,
  dir: string,
): ExtensionManifest {
  assertValidExtensionId(manifest.id, `adapted manifest directory ${dir}`)
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
    throw new Error(`Invalid adapted manifest in ${dir}: missing name`)
  }
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error(`Invalid adapted manifest in ${dir}: missing version`)
  }
  return manifest
}

/**
 * Resolve the first matching adapter without writing wrapper files. Installers
 * use this to validate the effective identity before replacing an existing
 * extension, and the normal loader validates it before wrapEntry can run.
 */
export async function inspectAdaptedExtension(dir: string): Promise<AdaptedExtension | null> {
  for (const adapter of adapters) {
    if (!await adapter.canLoad(dir)) continue
    const manifest = assertValidAdaptedManifest(await adapter.toManifest(dir), dir)
    return { adapter, manifest }
  }
  return null
}

/**
 * Try to detect and convert a directory to a codesurf extension manifest
 * using one of the registered adapters.
 * Returns null if no adapter recognises the format.
 */
export async function tryAdaptExtension(dir: string) {
  try {
    const adapted = await inspectAdaptedExtension(dir)
    if (!adapted) return null
    if (adapted.adapter.wrapEntry) {
      await adapted.adapter.wrapEntry(dir, adapted.manifest)
    }
    extLog.info(`Adapted ${dir} via ${adapted.adapter.name} adapter`)
    return adapted.manifest
  } catch (err) {
    console.warn(`[Extensions] Adapter failed for ${dir}:`, err)
    return null
  }
}

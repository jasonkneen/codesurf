/**
 * Interface that all extension format adapters must implement.
 */

import type { ExtensionManifest } from '../../../shared/types'

export interface ExtensionAdapter {
  /** Adapter name (for logging). */
  name: string

  /**
   * Return true if this adapter can handle the given directory.
   * Should be fast — just check for marker files (package.json, SKILL.md, etc.)
   */
  canLoad(dir: string): Promise<boolean>

  /**
   * Parse the directory and produce a contex ExtensionManifest.
   * Called only when canLoad() returned true.
   */
  toManifest(dir: string): Promise<ExtensionManifest>

  /**
   * Optional: generate shim/wrapper files needed to run the extension.
   * For example, the Raycast adapter generates HTML shims for each command.
   */
  wrapEntry?(dir: string, manifest: ExtensionManifest): Promise<string>
}

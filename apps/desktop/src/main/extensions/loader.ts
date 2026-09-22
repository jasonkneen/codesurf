/**
 * Power extension loader — requires and activates Node.js (power-tier) extensions.
 *
 * TRUST BOUNDARY — power/node extensions run with full Electron main-process
 * privileges: unrestricted Node.js (fs, child_process, net, require, etc.).
 * This is equivalent to installing a native application.  The capability
 * system governing the iframe bridge does NOT constrain power extensions.
 *
 * Activation is gated in registry.ts (resolveExtensionEnabled):
 *   - bundled / global-install extensions  → enabled by default
 *   - catalog extensions                   → default-OFF; require explicit
 *                                            user enable via the gallery
 *   - workspace-local extensions           → default-OFF (untrustedScope);
 *                                            require explicit user enable
 *
 * Default: non-bundled power extensions run through the utilityProcess broker (Phase 1b/1c).
 * Set CODESURF_POWER_BROKER=0 to force the legacy raw require() path for all extensions.
 * The raw require() path is never deleted; bundled extensions always run legacy until Phase 1d is proven.
 *
 * Per-manifest override: manifest.execution = 'worker' forces brokered mode
 * for a single extension regardless of the global flag.
 */

import { join, resolve, sep } from 'path'
import type { ExtensionManifest } from '../../shared/types'
import type { ExtensionContext } from './context'
import type { ExtensionRegistry } from './registry'
import { log } from '../utils/logger.ts'

/**
 * Scope categories used for activation gate decisions.  Keep in sync with the
 * scopes understood by registry.ts / activation-policy.ts.
 */
export type ExtensionScope = 'bundled' | 'global' | 'catalog' | 'workspace'

/**
 * Throws if `relativeMain` resolves outside `basePath`.
 * Prevents path-traversal attacks via a malicious manifest.main (e.g. "../../evil.js").
 */
export function assertSafeExtensionEntry(basePath: string, relativeMain: string): void {
  const resolvedBase = resolve(basePath)
  const resolvedEntry = resolve(basePath, relativeMain)
  if (resolvedEntry !== resolvedBase && !resolvedEntry.startsWith(resolvedBase + sep)) {
    throw new Error(
      `[Security] Extension manifest.main "${relativeMain}" escapes extension directory`,
    )
  }
}

/**
 * Guard called immediately before require() + activate().  Returns true when
 * loading is permitted, false when it must be blocked.
 *
 * This is a defense-in-depth boundary: the primary gate lives in
 * resolveExtensionEnabled (activation-policy.ts) and is applied at scan time.
 * This secondary check prevents an unexpected code path from activating an
 * extension that should be disabled.
 */
export function isPowerActivationPermitted(
  manifest: ExtensionManifest,
  scope: ExtensionScope,
): boolean {
  if (!manifest._enabled) {
    if (scope === 'workspace') {
      // Workspace extensions are attacker-controllable (any cloned repo can ship
      // .codesurf/extensions/).  Enforce that they passed the untrustedScope gate.
      console.error(
        `[Security] Blocked activation of workspace power extension "${manifest.name}" (${manifest.id}): ` +
        `workspace-local power extensions require explicit user opt-in.`,
      )
    } else {
      // An extension that did not pass resolveExtensionEnabled must never execute.
      console.error(
        `[Security] Blocked activation of power extension "${manifest.name}" (${manifest.id}): ` +
        `_enabled is false — this extension must be explicitly enabled by the user before it can run.`,
      )
    }
    return false
  }

  return true
}

export async function loadPowerExtension(
  manifest: ExtensionManifest,
  ctx: ExtensionContext,
  scope: ExtensionScope = 'global',
): Promise<(() => void) | null> {
  if (!manifest.main || !manifest._path) return null

  // Defense-in-depth gate: block if the extension should not be active.
  if (!isPowerActivationPermitted(manifest, scope)) {
    return null
  }

  const prefix = `[Ext:${manifest.name}]`

  try {
    // Guard against path traversal before computing entryPath or logging it.
    assertSafeExtensionEntry(manifest._path, manifest.main)

    const entryPath = join(manifest._path, manifest.main)

    // Emit a conspicuous warning so any audit of the process log can identify
    // which extensions are running with full main-process privileges.
    console.warn(
      `[Security] Loading power extension "${manifest.name}" (${manifest.id}) ` +
      `from ${entryPath} — runs with FULL main-process privileges (Node.js, fs, ` +
      `child_process, network). Scope: ${scope}.`,
    )

    // Clear require cache so extensions can be hot-reloaded
    delete require.cache[require.resolve(entryPath)]
    const mod = require(entryPath)

    if (typeof mod.activate !== 'function') {
      console.warn(`${prefix} No activate() export found in ${entryPath}`)
      return null
    }

    log.debug(`${prefix} Activating power extension...`)
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

// ── Broker feature flag ───────────────────────────────────────────────────────

/**
 * Returns true when a power extension should run in the brokered
 * utilityProcess tier rather than via the legacy raw require() path.
 *
 * Phase 1d status: proven green via test/hosts/broker-host-integration.test.mjs.
 * The default is brokered for global/catalog/workspace extensions; bundled
 * extensions remain legacy. CODESURF_POWER_BROKER=0 is the escape hatch.
 *
 * Rules (first match wins):
 *  1. CODESURF_POWER_BROKER=0  → force legacy for ALL extensions.
 *  2. manifest.execution==='worker'  → force broker for this extension.
 *  3. bundled scope  → always legacy (safest default; no regression risk).
 *  4. CODESURF_POWER_BROKER=1 OR default (non-bundled)  → broker.
 *     codesurf-relay-suite is the first consumer; its relay grant is validated
 *     in main before registerRelayIPC() runs.
 *
 * Legacy-scope exceptions:
 *  - Bundled extensions: always legacy until 1d is fully proven in production.
 */
export function shouldBrokerExtension(
  manifest: ExtensionManifest,
  scope: ExtensionScope,
): boolean {
  // Escape hatch: opt-out of broker for all extensions
  if (process.env.CODESURF_POWER_BROKER === '0') return false

  // Per-manifest override: force broker regardless of scope
  if ((manifest as { execution?: string }).execution === 'worker') return true

  // Bundled extensions keep the legacy path for maximum stability
  if (scope === 'bundled') return false

  // Non-bundled: run brokered by default (opt-out via CODESURF_POWER_BROKER=0)
  // CODESURF_POWER_BROKER=1 makes this explicit; absence is the same default.
  return true
}

/**
 * Activate a power extension via either the broker or the legacy require() path.
 *
 * Drop-in replacement for direct `loadPowerExtension` calls at the registry
 * call sites. When the flag is off (default) the legacy body is called
 * unchanged.
 *
 * Note: when brokered, `ctx` is still constructed by the CALLER (registry.ts)
 * and passed in — the broker host also creates its own ctx internally.  For
 * legacy mode the passed ctx is used directly.  For broker mode the registry's
 * ctx is discarded (the host owns lifecycle) and a separate ctx is built inside
 * ExtensionBrokerHost.activate().
 */
export async function activatePowerExtension(
  manifest: ExtensionManifest,
  ctx: ExtensionContext,
  scope: ExtensionScope,
  registry: ExtensionRegistry,
): Promise<(() => void) | null> {
  if (shouldBrokerExtension(manifest, scope)) {
    // Lazy import to avoid loading electron utilityProcess in test environments
    // where it's not available.
    const { ExtensionBrokerHost } = await import('./broker/host')
    const host = new ExtensionBrokerHost(manifest, registry, scope)
    const ok = await host.activate()
    if (!ok) return null
    return host.buildCleanupFn()
  }
  // Legacy raw require() path — body unchanged
  return loadPowerExtension(manifest, ctx, scope)
}

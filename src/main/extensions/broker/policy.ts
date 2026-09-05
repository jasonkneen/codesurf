/**
 * Capability policy for the plugin execution broker.
 *
 * Enforcement lives ONLY in main — the child process never evaluates grants.
 * Every capability call that arrives from the child is validated here before
 * any executor runs.
 *
 * SECURITY SCOPE NOTE: The capability surface controlled here covers the ctx
 * API (bus, mcp, ipc, settings, store, relayHost). A child utilityProcess can
 * still call Node builtins (fs, child_process, etc.) directly — true OS-level
 * confinement is out of scope for Phase 1. The broker enforces that the *ctx*
 * surface is gated, blocking extensions from using relayHost, canvas, etc.
 * unless explicitly granted by the user.
 */

import type { BrokerErrorCode } from './protocol'

/**
 * ctx namespaces that every extension receives without any explicit grant.
 * These mirror the iframe bridge BASELINE surface.
 */
const BASELINE_NAMESPACES = new Set([
  'bus',
  'mcp',
  'ipc',
  'settings',
  'store',
  'log',
])

/**
 * Namespaces that require a specific grant name (may differ from the ns name).
 * Keys are ctx namespace names; values are the capability grant name to check.
 */
const GATED_NAMESPACES: Record<string, string> = {
  relayHost: 'relay',
  chat: 'chat',
  canvas: 'canvas',
  fs: 'fs',
  shell: 'shell',
  network: 'network',
  secrets: 'secrets',
  chrome: 'chrome',
  daemon: 'daemon',
}

/**
 * Maps a ctx namespace string to its corresponding capability grant name.
 * e.g. 'relayHost' -> 'relay', 'bus' -> 'bus'
 */
export function capabilityForNamespace(ns: string): string {
  return GATED_NAMESPACES[ns] ?? ns
}

/**
 * Validate a capability call from a child extension against its gate.
 *
 * Returns `{ ok: true }` when the call is permitted, or
 * `{ ok: false, code, message }` when it must be rejected.
 */
export function validateCapabilityCall(
  gate: { enforced: boolean; granted: string[] },
  extId: string,
  capability: string,
  method: string,
): { ok: true } | { ok: false; code: BrokerErrorCode; message: string } {
  // Baseline namespaces are always allowed regardless of grant state.
  if (BASELINE_NAMESPACES.has(capability)) {
    return { ok: true }
  }

  // For gated namespaces look up the required grant name.
  const requiredGrant = GATED_NAMESPACES[capability]
  if (requiredGrant === undefined) {
    // Unknown namespace — no executor registered in main.
    return {
      ok: false,
      code: 'capability-unknown',
      message: `Extension "${extId}" called unknown capability "${capability}.${method}" — no executor registered`,
    }
  }

  // Check that the grant is present.
  if (gate.granted.includes(requiredGrant)) {
    return { ok: true }
  }

  // `enforced` is false when the manifest declares no capabilities at all. That
  // does NOT mean "ungated" — gated namespaces stay denied, which is the safe
  // default and the behaviour relied on today. It is read here only to explain
  // the denial accurately: "you are not granted fs" is misleading when the
  // manifest never declared any capability in the first place, and it sent
  // authors looking for a revoked grant instead of a missing declaration.
  if (!gate.enforced) {
    return {
      ok: false,
      code: 'capability-denied',
      message:
        `Extension "${extId}" called gated capability "${capability}.${method}" but its manifest declares no ` +
        `"capabilities". Add { "capabilities": [{ "name": "${requiredGrant}" }] } to extension.json and re-enable it.`,
    }
  }

  return {
    ok: false,
    code: 'capability-denied',
    message: `Extension "${extId}" is not granted capability "${requiredGrant}" (called "${capability}.${method}")`,
  }
}

/**
 * Environment variables forwarded to an extension child process.
 *
 * The broker previously forked children with `{ ...process.env }`, handing every
 * third-party extension the main process's entire environment — including
 * AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY and anything else the user exported
 * before launching the app. An extension only needs enough to resolve binaries
 * and find its own data.
 *
 * Anything not listed here is dropped. That is deliberate: a missing variable
 * makes an extension fail loudly and is trivially fixable by extending this
 * list, whereas a leaked credential is silent and unrecoverable.
 */
export const BROKER_CHILD_ENV_ALLOWLIST: readonly string[] = [
  // Process/binary resolution
  'PATH', 'SHELL', 'HOME', 'USER', 'LOGNAME',
  // Temp dirs
  'TMPDIR', 'TEMP', 'TMP',
  // Locale / time
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  // Runtime mode
  'NODE_ENV', 'CI',
  // App's own non-secret configuration
  'CODESURF_HOME', 'CODESURF_WORKSPACE_ID', 'CODESURF_POWER_BROKER', 'CODESURF_BROKER_TEST',
  // Windows essentials
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA',
  'USERPROFILE', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'NUMBER_OF_PROCESSORS',
]

/**
 * Defence in depth: even a variable on the allow-list is dropped if its NAME
 * looks like a credential, so widening the list above cannot silently
 * reintroduce a leak.
 */
const SECRET_NAME_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION|COOKIE|PRIVATE)/i

export function buildBrokerChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of BROKER_CHILD_ENV_ALLOWLIST) {
    const value = parentEnv[name]
    if (typeof value !== 'string') continue
    if (SECRET_NAME_PATTERN.test(name)) continue
    env[name] = value
  }
  return { ...env, ...extra }
}

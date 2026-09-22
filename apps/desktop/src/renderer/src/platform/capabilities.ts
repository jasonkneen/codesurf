/**
 * Platform capability matrix — single source of truth for what each host exposes.
 *
 * Electron is full-fidelity. Web/Native install a daemon-backed facade with a
 * scoped subset; terminal availability depends on the gateway/sidecar at runtime.
 */

import type { CodesurfPlatform } from './detect'

export type PlatformCapabilityKey =
  | 'workspace'
  | 'canvas'
  | 'settings'
  | 'chatJobs'
  | 'sessions'
  | 'activity'
  | 'fs'
  | 'terminal'
  | 'extensions'
  | 'nodePty'
  | 'mcp'
  | 'shell'
  | 'nativeDialogs'

export type PlatformCapabilities = Record<PlatformCapabilityKey, boolean>

export const PLATFORM_CAPABILITY_KEYS: readonly PlatformCapabilityKey[] = [
  'workspace',
  'canvas',
  'settings',
  'chatJobs',
  'sessions',
  'activity',
  'fs',
  'terminal',
  'extensions',
  'nodePty',
  'mcp',
  'shell',
  'nativeDialogs',
] as const

/** Full Electron surface — node-pty terminals, extensions, MCP, shell. */
const ELECTRON_CAPABILITIES: PlatformCapabilities = {
  workspace: true,
  canvas: true,
  settings: true,
  chatJobs: true,
  sessions: true,
  activity: true,
  fs: true,
  terminal: true,
  extensions: true,
  nodePty: true,
  mcp: true,
  shell: true,
  nativeDialogs: true,
}

/**
 * Daemon-backed hosts share the same core matrix; terminal and native dialogs
 * vary by shell (browser vs Native WebView).
 */
export function defaultCapabilitiesFor(
  platform: CodesurfPlatform,
  opts?: { terminalAvailable?: boolean },
): PlatformCapabilities {
  if (platform === 'electron') {
    return { ...ELECTRON_CAPABILITIES }
  }

  const terminalAvailable = opts?.terminalAvailable ?? false
  return {
    workspace: true,
    canvas: true,
    settings: true,
    chatJobs: true,
    sessions: true,
    activity: false,
    fs: true,
    terminal: terminalAvailable,
    extensions: false,
    nodePty: false,
    mcp: false,
    shell: platform === 'native',
    nativeDialogs: platform === 'native',
  }
}

/** Read the capability map installed by installHostBridge (if any). */
export function readInstalledCapabilities(
  win: Window | undefined | null = typeof window !== 'undefined' ? window : null,
): PlatformCapabilities | null {
  if (!win) return null
  const raw = (win as Window & { __CODESURF_CAPABILITIES__?: Record<string, boolean> })
    .__CODESURF_CAPABILITIES__
  if (!raw || typeof raw !== 'object') return null
  return normalizeCapabilities(raw)
}

/** Coerce a partial/loose map into a full PlatformCapabilities object. */
export function normalizeCapabilities(
  partial: Record<string, boolean | undefined>,
  platform: CodesurfPlatform = 'web',
): PlatformCapabilities {
  const base = defaultCapabilitiesFor(platform)
  const out = { ...base }
  for (const key of PLATFORM_CAPABILITY_KEYS) {
    if (typeof partial[key] === 'boolean') out[key] = partial[key]!
  }
  return out
}

export function hasCapability(
  key: PlatformCapabilityKey,
  win: Window | undefined | null = typeof window !== 'undefined' ? window : null,
): boolean {
  const installed = readInstalledCapabilities(win)
  if (installed) return installed[key] === true
  // No bridge yet — conservative defaults from platform detect is caller's job.
  return false
}

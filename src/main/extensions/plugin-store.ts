/**
 * Plugin Store — durable, reactive, per-plugin state.
 *
 * Each plugin gets a JSON document at ~/.codesurf/plugin-state/<id>.json with an
 * in-memory cache. Writes persist immediately and broadcast on the event bus channel
 * `plugin:<id>:state`, so every renderer (host UI, the plugin's own iframe, peer
 * plugins that subscribe) sees changes live. This is the durable store extensions
 * lacked — it fixes the class of bug where iframe state (e.g. Builder history) was
 * lost on reload, and is the substrate for stateful plugins.
 *
 * Decision (docs/plugins/00-architecture.md §5): extend the existing file-based
 * persistence + event bus rather than adopt a heavy replicated DB.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'fs'
import { join } from 'path'
import { CODESURF_HOME } from '../paths'
import { bus } from '../event-bus'
import { assertSafePathSegment } from '../security/pathSegments'

const STORE_DIR = join(CODESURF_HOME, 'plugin-state')
const cache = new Map<string, Record<string, unknown>>()

function fileFor(extId: string): string {
  // extId comes from renderer IPC — validate before it becomes a filename so
  // '../mcp-server' can't read/overwrite files outside the store dir.
  return join(STORE_DIR, `${assertSafePathSegment(extId, 'extId')}.json`)
}

export function stateChannel(extId: string): string {
  return `plugin:${extId}:state`
}

/** Read a plugin's full state (cached; falls back to {} on first read / missing file). */
export function getPluginState(extId: string): Record<string, unknown> {
  const cached = cache.get(extId)
  if (cached) return cached
  const file = fileFor(extId)
  let value: Record<string, unknown> = {}
  let readable = true
  try {
    value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
  } catch (err) {
    value = {}
    // Distinguish "no state yet" from "state is corrupt". Caching {} for a
    // corrupt file made the next setPluginState spread over {} and rewrite the
    // file, turning a recoverable partial write into permanent loss.
    if (existsSync(file)) {
      readable = false
      try {
        renameSync(file, `${file}.bad-${Date.now()}`)
        console.warn(`[plugin-store] unreadable state for ${extId}; preserved as .bad`, err)
      } catch (renameErr) {
        console.warn(`[plugin-store] unreadable state for ${extId}; could not preserve it`, renameErr)
      }
    }
  }
  if (readable) cache.set(extId, value)
  return value
}

function persist(extId: string, value: Record<string, unknown>): void {
  // Write atomically: temp file, fsync, rename. A bare writeFileSync can leave
  // truncated JSON on power loss, and the old code additionally swallowed the
  // failure while still publishing a success event, so subscribers believed a
  // write had landed that had not.
  const file = fileFor(extId)
  const tmp = `${file}.${process.pid}.tmp`
  mkdirSync(STORE_DIR, { recursive: true })
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'wx')
    writeSync(fd, JSON.stringify(value, null, 2))
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, file)
  } catch (err) {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* already closed */ } }
    try { unlinkSync(tmp) } catch { /* nothing to clean */ }
    console.warn(`[plugin-store] write failed for ${extId}:`, err)
    // Do NOT cache or announce a state that is not on disk.
    throw err instanceof Error ? err : new Error(String(err))
  }

  cache.set(extId, value)
  bus.publish({
    channel: stateChannel(extId),
    type: 'data',
    source: 'plugin-store',
    payload: { extId, state: value },
  })
}

/** Shallow-merge a patch into the plugin's state. Returns the new state. */
export function setPluginState(extId: string, patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...getPluginState(extId), ...patch }
  persist(extId, next)
  return next
}

/** Replace the plugin's entire state. Returns the new state. */
export function replacePluginState(extId: string, value: Record<string, unknown>): Record<string, unknown> {
  persist(extId, value)
  return value
}

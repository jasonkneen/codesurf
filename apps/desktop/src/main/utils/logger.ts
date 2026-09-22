/**
 * Leveled logger for the Electron main process.
 *
 * One place to control main-process logging: gating, format, and (later) file
 * output / remote forwarding. Replaces ad-hoc `console.log/warn/error` so the
 * boot path and hot loops aren't noisy by default and every line carries a
 * consistent `[scope]` prefix.
 *
 * Levels:
 *   error  → stderr, always on. Failures the operator must see.
 *   warn   → stderr, always on. Recoverable but surprising.
 *   info   → stdout, gated on CODESURF_LOG=info|debug. Lifecycle/lifecycle-ish.
 *   debug  → stdout, gated on CODESURF_LOG=debug. Verbose diagnostics.
 *
 * Usage:
 *   import { log } from './utils/logger.ts'
 *   const mcp = log.scope('MCP')
 *   mcp.info('server running on port', port)
 *   mcp.warn('could not update gitignore')
 *   mcp.error('failed to start', err)
 *
 * The default export `log` is an unscoped logger; prefer `scope()` per module.
 */

type Level = 'error' | 'warn' | 'info' | 'debug'

const LEVEL_PRIORITY: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 }

function currentMaxPriority(): number {
  const env = (process.env.CODESURF_LOG ?? '').toLowerCase().trim()
  if (env === 'debug') return LEVEL_PRIORITY.debug
  if (env === 'info') return LEVEL_PRIORITY.info
  // Default: errors and warnings only. Keeps the boot path quiet unless asked.
  return LEVEL_PRIORITY.warn
}

function format(scope: string | undefined, args: unknown[]): unknown[] {
  if (!scope) return args
  // Prepend the `[scope]` tag as a string so it stays adjacent to the first arg
  // in formatted output (matches the previous `console.log('[MCP]', …)` shape).
  return [`[${scope}]`, ...args]
}

function emit(level: Level, scope: string | undefined, args: unknown[]): void {
  if (LEVEL_PRIORITY[level] > currentMaxPriority()) return
  const formatted = format(scope, args)
  if (level === 'error' || level === 'warn') {
    console[level === 'error' ? 'error' : 'warn'](...formatted)
  } else {
    console.log(...formatted)
  }
}

export interface ScopedLogger {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  /** Create a nested scope, e.g. `log.scope('MCP').scope('auth')` → `[MCP:auth]`. */
  scope: (child: string) => ScopedLogger
}

function createScoped(scope: string | undefined): ScopedLogger {
  return {
    error: (...args: unknown[]) => emit('error', scope, args),
    warn: (...args: unknown[]) => emit('warn', scope, args),
    info: (...args: unknown[]) => emit('info', scope, args),
    debug: (...args: unknown[]) => emit('debug', scope, args),
    scope: (child: string) => createScoped(scope ? `${scope}:${child}` : child),
  }
}

/** Unscoped logger. Prefer `log.scope('MODULE')` in each file. */
export const log: ScopedLogger = createScoped(undefined)

/** Convenience: create a scoped logger in one call. */
export function scope(tag: string): ScopedLogger {
  return createScoped(tag)
}

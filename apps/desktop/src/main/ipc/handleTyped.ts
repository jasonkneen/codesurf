/**
 * Typed, validating wrappers for `ipcMain.handle`.
 *
 * The renderer→main boundary carries untrusted data. A compromised renderer
 * (or a buggy one) can send malformed args to side-effecting handlers —
 * `terminal:write` with a non-string, `canvas:save` with a shape that breaks
 * assumptions, `fs:deleteFile` with traversal payload that slips past a missing
 * validator. Historically every handler hand-casts `(event, a: string, b: any)`
 * with no runtime check.
 *
 * `handleTyped` validates the args tuple against a tuple of zod schemas before
 * the handler runs. On failure it throws a structured error (caught by the
 * `tryValidateHandle` boundary below) instead of letting the handler proceed
 * with garbage. This converts a class of "renderer says jump, main says how
 * high" bugs into hard, loud failures.
 *
 * Usage:
 *   handleTyped('terminal:write', {
 *     args: [zod.string(), zod.string()] as const,
 *     handler: async (_evt, tileId, data) => { ... },
 *   })
 *
 * The `args` tuple is `as const` so the handler receives correctly-typed,
 * narrowed parameters.
 */
import { createRequire } from 'node:module'
import { z, type ZodType } from 'zod'

let requireElectron: ReturnType<typeof createRequire> | null = null

function getElectronRequire(): ReturnType<typeof createRequire> {
  if (requireElectron) return requireElectron
  // Some security tests bundle main-process modules to CommonJS, where
  // esbuild intentionally replaces `import.meta` with an empty object. Use
  // the native CommonJS loader there and construct one only in real ESM.
  requireElectron = typeof require === 'function'
    ? require
    : createRequire(import.meta.url)
  return requireElectron
}

// Lazy electron require — the ipc/ modules are imported by unit tests that run
// in plain node (no Electron runtime). A static `import { ipcMain } from
// 'electron'` throws at link time there. Mirrors the pattern in fs.ts.
function getIpcMain(): typeof import('electron')['ipcMain'] {
  return getElectronRequire()('electron').ipcMain
}

export type TypedHandler<Spec extends readonly ZodType[]> = (
  event: import('electron').IpcMainInvokeEvent,
  ...args: { [K in keyof Spec]: z.infer<Spec[K]> }
) => unknown

export interface HandleTypedOptions<Spec extends readonly ZodType[]> {
  args: Spec
  handler: TypedHandler<Spec>
}

class IpcValidationError extends Error {
  readonly channel: string
  readonly issues: unknown
  constructor(channel: string, issues: unknown) {
    super(`[${channel}] argument validation failed`)
    this.name = 'IpcValidationError'
    this.channel = channel
    this.issues = issues
  }
}

/**
 * Register an `ipcMain.handle` that validates its args tuple before invoking
 * the handler. Invalid args reject the IPC promise with a clear message and
 * never reach the handler body.
 */
export function handleTyped<Spec extends readonly ZodType[]>(
  channel: string,
  options: HandleTypedOptions<Spec>,
  ipcMainOverride?: Pick<typeof import('electron')['ipcMain'], 'handle'>,
): void {
  const { args: schemas, handler } = options
  const ipcMain = ipcMainOverride ?? getIpcMain()
  ipcMain.handle(channel, async (event, ...rawArgs) => {
    if (rawArgs.length > schemas.length) {
      throw new IpcValidationError(channel, {
        message: `too many arguments: expected ${schemas.length}, got ${rawArgs.length}`,
      })
    }
    const parsed: unknown[] = []
    for (let i = 0; i < schemas.length; i++) {
      const schema = schemas[i]
      // Optional trailing args: allow `undefined` when the renderer omits them.
      const raw = i < rawArgs.length ? rawArgs[i] : undefined
      const result = schema.safeParse(raw)
      if (!result.success) {
        throw new IpcValidationError(channel, {
          index: i,
          issues: result.error.issues,
        })
      }
      parsed.push(result.data)
    }
    return handler(event, ...(parsed as { [K in keyof Spec]: z.infer<Spec[K]> }))
  })
}

/**
 * Coarse schemas reusable across handlers. Keep these intentionally permissive
 * on shape (strings of bounded length) — the handler still does its own
 * semantic validation (path scoping, allowlists). The goal here is to kill
 * `any`-shaped payloads, not to duplicate the semantic checks.
 */
export const ipcSchemas = {
  /** Non-empty string, max 4KB. For ids, paths (pre-scoping), channel names. */
  boundedString: (max = 4096) => z.string().min(1).max(max),
  /** Free-form file contents. Capped at 25MB so a compromised renderer can't
   *  OOM the main process by writing a giant string to disk. */
  fileContent: z.string().max(25 * 1024 * 1024),
  /** Arbitrary terminal input. Capped at 1MB per write. */
  terminalData: z.string().max(1024 * 1024),
  /** Optional string (trailing arg). Omitted → undefined. */
  optionalString: z.string().optional(),
  /** Array of strings (e.g. launch args). Bounded length. */
  stringArray: z.array(z.string().max(8192)).max(256),
  /** Unknown-but-not-null — passes through for handlers that do their own parse. */
  passthroughObject: z.record(z.string(), z.unknown()),
}

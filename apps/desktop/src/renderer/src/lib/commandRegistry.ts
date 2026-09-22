/**
 * Command execution for the Command Palette + /slash commands.
 *
 * A command is a plugin contribution (`contributes.commands[]`, see
 * src/shared/types.ts → ExtensionCommandContrib) tagged with its owning plugin id.
 * Running one:
 *   1. dispatches a `codesurf:command` window event (host code can bind built-in
 *      commands by id without coupling the palette to App.tsx internals), and
 *   2. for `run.method` commands, invokes the owning plugin's power-tier IPC handler
 *      (ext:<id>:<method>) via the existing extensions bridge.
 *
 * Built-in commands and `run.action` routing layer on top of the same event in later
 * phases; this keeps the palette decoupled and additive today.
 */

import type { ExtensionCommandContrib } from '../../../shared/types'

export type PaletteCommand = ExtensionCommandContrib & { extId: string }

const el = (window as { electron?: any }).electron

export async function executeCommand(cmd: PaletteCommand): Promise<void> {
  // Let host code react to any command by id (built-ins, analytics, etc.).
  window.dispatchEvent(new CustomEvent('codesurf:command', { detail: cmd }))
  try {
    if (cmd.run?.method && cmd.extId) {
      await el?.extensions?.invoke?.(cmd.extId, cmd.run.method)
    }
  } catch (err) {
    console.warn(`[commands] "${cmd.id}" failed:`, err)
  }
}

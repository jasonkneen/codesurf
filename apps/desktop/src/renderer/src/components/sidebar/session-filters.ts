import type { SessionEntry } from './types'

export function isInternalMaintenanceSession(session: SessionEntry): boolean {
  const title = String(session.title ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  if (!title) return false

  if (title === '<environment_context>') return true
  if (title.startsWith('update the generated workspace memory file for codesurf')) return true
  if (title.startsWith('generate metadata for a coding agent based on the user prompt')) return true

  return false
}

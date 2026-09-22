/**
 * Built-in views as first-class contributions (point 7 — "how are built-ins handled").
 *
 * The 11 built-in tile types are surfaced through the SAME command/contribution
 * surface as plugin views, so built-ins and plugins are uniform from the user's and
 * the registry's perspective. Rendering is intentionally UNCHANGED — App.tsx's
 * addTile + the BuiltinTileType union/switch still draw them — so this is a pure,
 * additive "rewire": built-ins gain palette presence (and, as surfaces migrate, Slot
 * presence) with zero regression. New built-ins are added here once.
 */

import type { BuiltinTileType } from '../../../shared/types'

export interface BuiltinView {
  type: BuiltinTileType
  label: string
}

export const BUILTIN_VIEWS: BuiltinView[] = [
  { type: 'chat', label: 'Chat' },
  { type: 'terminal', label: 'Terminal' },
  { type: 'code', label: 'Code Editor' },
  { type: 'note', label: 'Note' },
  { type: 'files', label: 'File Tree' },
  { type: 'file', label: 'File' },
  { type: 'browser', label: 'Browser' },
  { type: 'kanban', label: 'Board' },
  { type: 'image', label: 'Image' },
  { type: 'media', label: 'Media' },
  { type: 'customisation', label: 'Customisation' },
]

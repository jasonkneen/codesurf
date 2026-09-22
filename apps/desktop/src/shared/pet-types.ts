// Pet types + atlas geometry — shared across main process and renderer.
//
// Bundle format (compatible with codex-rs, grok-cli, hermes, cursorbuddy):
//   <pet-id>/
//     pet.json          { id, displayName, description, spritesheetPath }
//     spritesheet.webp  1536 × 1872, 8 × 9 grid of 192 × 208 cells
//
// Each row in the spritesheet is a named animation track. Durations are in
// seconds at 1× playback. The renderer cycles frames at the row's cadence
// and switches rows based on agent activity events.

// ── Atlas geometry ─────────────────────────────────────────────────────────────

export const ATLAS = Object.freeze({
  cellWidth: 192,
  cellHeight: 208,
  columns: 8,
  rows: 9,
  totalWidth: 192 * 8, // 1536
  totalHeight: 208 * 9, // 1872
})

export type AnimationRow =
  | 'idle'
  | 'runningRight'
  | 'runningLeft'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review'

export const ROW_INDEX: Record<AnimationRow, number> = Object.freeze({
  idle: 0,
  runningRight: 1,
  runningLeft: 2,
  waving: 3,
  jumping: 4,
  failed: 5,
  waiting: 6,
  running: 7,
  review: 8,
})

export const FRAME_DURATIONS: Readonly<Record<AnimationRow, readonly number[]>> = Object.freeze({
  idle: [0.28, 0.11, 0.11, 0.14, 0.14, 0.32],
  runningRight: [0.12, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12, 0.22],
  runningLeft: [0.12, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12, 0.22],
  waving: [0.14, 0.14, 0.14, 0.28],
  jumping: [0.14, 0.14, 0.14, 0.14, 0.28],
  failed: [0.14, 0.14, 0.14, 0.14, 0.14, 0.14, 0.14, 0.24],
  waiting: [0.15, 0.15, 0.15, 0.15, 0.15, 0.26],
  running: [0.12, 0.12, 0.12, 0.12, 0.12, 0.22],
  review: [0.15, 0.15, 0.15, 0.15, 0.15, 0.28],
})

export function frameCount(row: AnimationRow): number {
  return FRAME_DURATIONS[row].length
}

// ── Manifest types ─────────────────────────────────────────────────────────────

export interface PetManifest {
  /** Unique slug identifier (used as directory name). */
  id: string
  displayName: string
  description: string
  /** Absolute path to the spritesheet file (WebP or PNG). */
  spritesheetPath: string
  /** Directory the pet was loaded from. */
  bundleDir: string
  /** MIME hint derived from the spritesheet extension. */
  spritesheetMime: 'image/webp' | 'image/png' | 'application/octet-stream'
  /** True when the pet is installed in the primary scan dir. */
  installed: boolean
  /** Optional category tag. */
  category?: string
  /** Optional source URL for attribution. */
  sourceUrl?: string
}

export interface PetGalleryEntry {
  id: string
  displayName: string
  description: string
  category?: string
  installed: boolean
}

export interface PetSettings {
  enabled: boolean
  slug: string
  scale: number
}

export const DEFAULT_PET_SETTINGS: PetSettings = Object.freeze({
  enabled: false,
  slug: '',
  scale: 0.33,
})

export const PET_SCALE_MIN = 0.1
export const PET_SCALE_MAX = 3.0

// ── Pet RPC types (IPC boundary) ────────────────────────────────────────────────

export type PetListResponse = PetManifest[]
export type PetGalleryResponse = PetGalleryEntry[]
export type PetInstallResponse = { ok: boolean; error?: string }
export type PetRemoveResponse = { ok: boolean; error?: string }

// The active row currently animating; renderer switches this based on bus events.
export type PetActiveRow = AnimationRow | 'static'

// ── Scan directories ────────────────────────────────────────────────────────────

// Scan order: first hit wins. The primary dir (~/.codesurf/pets) is where
// installs go; the others are read-only overlays so pets installed via
// codex/hermes are visible in CodeSurf too.
export function petScanDirs(codesurfHome: string, codexHome: string, hermesHome: string): string[] {
  return [
    `${codesurfHome}/pets`,
    `${codexHome}/pets`,
    `${hermesHome}/pets`,
  ]
}

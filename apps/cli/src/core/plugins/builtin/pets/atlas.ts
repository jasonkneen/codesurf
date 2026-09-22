/**
 * Pet Atlas Contract — TypeScript twin of cursorbuddy's
 * `electron/lib/pet-atlas.js` / `src/lib/pet-atlas.ts`.
 *
 * Ported verbatim (with attribution) from
 * /Users/jkneen/Documents/GitHub/cursorbuddy/src/lib/pet-atlas.ts so
 * grok-cli, cursorbuddy, and openclicky share the same on-disk
 * spritesheet contract. Any change here MUST be mirrored upstream in
 * the same commit — there's no runtime cross-check; mismatched
 * constants silently render the wrong frames.
 *
 * Reference geometry:
 *   - Cell:    192 × 208 px
 *   - Grid:    8 columns × 9 rows
 *   - Sheet:  1536 × 1872 px
 *
 * Each row is a named animation track; the durations array defines the
 * loop timing for that row at 1× playback. `frameAt(row, elapsed)`
 * returns the frame index to draw given the seconds since the row
 * became active.
 */

export const ATLAS = Object.freeze({
  cellWidth: 192,
  cellHeight: 208,
  columns: 8,
  rows: 9,
  totalWidth: 192 * 8, // 1536
  totalHeight: 208 * 9, // 1872
});

export type AnimationRow =
  | "idle"
  | "runningRight"
  | "runningLeft"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

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
});

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
});

export function frameCount(row: AnimationRow): number {
  return FRAME_DURATIONS[row].length;
}

/** Total time for one full loop of this row, in seconds. */
export function rowDuration(row: AnimationRow): number {
  return FRAME_DURATIONS[row].reduce((a, b) => a + b, 0);
}

/**
 * Return the frame index for a given elapsed time within the row's
 * looping cycle. Mirrors cursorbuddy's renderer.
 */
export function frameAt(row: AnimationRow, elapsedSeconds: number): number {
  const total = rowDuration(row);
  if (total <= 0) return 0;
  const t = ((elapsedSeconds % total) + total) % total;
  let acc = 0;
  const durations = FRAME_DURATIONS[row];
  for (let i = 0; i < durations.length; i++) {
    acc += durations[i]!;
    if (t < acc) return i;
  }
  return durations.length - 1;
}

export interface AtlasRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** Source rect in the spritesheet for a given row + frame. */
export function cellRect(row: AnimationRow, frameIndex: number): AtlasRect {
  return {
    sx: frameIndex * ATLAS.cellWidth,
    sy: ROW_INDEX[row] * ATLAS.cellHeight,
    sw: ATLAS.cellWidth,
    sh: ATLAS.cellHeight,
  };
}

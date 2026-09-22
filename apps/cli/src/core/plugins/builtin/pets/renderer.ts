// Ambient-pet renderer: owns the animation loop for the active pet
// and the lifecycle of the Kitty image (transmit on first display,
// re-place on every tick, delete on switch / shutdown).
//
// Why a polling loop and not a per-frame opentui hook: opentui owns
// the terminal renderer and writes cells on its own schedule. Kitty
// erases image segments in any cell the host writes to. Codex-rs
// re-emits the image inside ratatui's post-draw hook; we don't have
// an equivalent in @opentui/react, so we poll. Each tick:
//
//   - If it's time to advance to the next animation frame, transmit
//     the new frame's PNG with a fresh image id (a=T).
//   - Otherwise, re-place the current frame's image by id (a=p) —
//     cheap escape sequence, no re-upload.
//
// We rotate image ids across frames (0xC0DE + frameIndex) so the
// previous frame's image stays in the terminal's cache and deletion
// is explicit when we move on.

import type { Writable } from "node:stream";
import { type AnimationRow, ATLAS } from "./atlas";
import type { ExtractedFrame } from "./frames";
import {
  detectImageProtocol,
  type ImageProtocol,
  kittyDelete,
  kittyTransmitInline,
  kittyTransmitLocalFile,
  type ProtocolSupport,
  withSavedCursor,
} from "./protocol";

/**
 * Loader used by `setRow()` to fetch the per-frame PNG paths for a given
 * animation row of the currently-active pet. Wired by the extension
 * entrypoint (see pets.tsx) which has the manifest + frame extractor.
 *
 * Returning `null` means the loader doesn't know how to produce frames
 * for this row (e.g. non-canonical spritesheet); the renderer keeps its
 * current row in that case.
 */
export type RowLoader = (row: AnimationRow) => Promise<ExtractedFrame[] | null>;

// Base ambient image id. Mirrors codex-rs's 0xC0DE so coexisting
// installs don't fight over the same slot. Per-frame ids derive from
// this base + the frame index, allowing up to 16 frames (any row in
// the atlas fits).
const AMBIENT_IMAGE_BASE = 0xc0de;
const REPLACE_INTERVAL_MS = 80;
// Sprite height in terminal cells. Matches codex-rs/tui/src/pets/ambient.rs
// target: PET_TARGET_HEIGHT_PX (75) / TERMINAL_ROW_HEIGHT_PX (15) = 5 rows.
//
// We deliberately send ONLY the row count to the terminal and never a column
// count. Kitty-protocol terminals stretch the image to fill the c×r rectangle
// exactly when both are given — aspect ratio is discarded (ghostty
// `src/terminal/kitty/graphics_storage.zig`). With only `r` set they derive
// the width from the source aspect ratio and the real cell size, which is the
// one number this module has no way to read.
//
// The previous hard-coded `c=8` assumed a ~2:1 cell. On Ghostty with Berkeley
// Mono 15 the cell is ~2.18:1, so 5 rows needs ~10 columns; 8 rendered every
// pet at 80% width.
const SPRITE_ROWS = 5;
// Placement-only estimate of the width the terminal will choose, used solely
// to right-align the sprite. It never affects scaling, so a cell or two of
// error just shifts the parking spot. Cell aspect (height:width) sits around
// 1.8–2.4 for common terminal fonts.
const ASSUMED_CELL_ASPECT = 2.2;
const SPRITE_RESERVED_COLUMNS = Math.ceil(SPRITE_ROWS * ASSUMED_CELL_ASPECT * (ATLAS.cellWidth / ATLAS.cellHeight));
// Position: parked above where the composer typically sits. Codex's
// `tui_pet_anchor: Composer` adds a 10 px gap above the composer
// bottom — at ~15 px/row that's ~1 row, plus a typical 3-row composer.
// We don't have a composer-bottom-y service yet, so we hard-code a
// reasonable offset from the screen bottom; tune via these constants
// if your composer renders taller.
const RIGHT_MARGIN_COLS = 2;
const BOTTOM_MARGIN_ROWS = 4; // ≈ composer (3) + gap (1)

interface RendererState {
  frames: ExtractedFrame[];
  /** Indices of frames we've already transmitted (a=T) this session. */
  transmitted: Set<number>;
  /** Index of the frame currently displayed. */
  currentFrame: number;
  /** Timestamp the current frame became active. */
  frameStartedAt: number;
  protocol: ImageProtocol;
  /** Currently-rendered row, used to suppress redundant setRow calls. */
  row: AnimationRow;
  /** How to fetch frames for a new row. */
  rowLoader: RowLoader | null;
}

let state: RendererState | null = null;
let timer: NodeJS.Timeout | null = null;
let stdoutRef: Writable = process.stdout;
// Process-exit teardown (clearing Kitty images on exit / SIGHUP) is registered
// by the pets extension via `api.onProcessExit(deactivatePet)` (see pets.tsx),
// so the host's aggregated exit handler owns it — no per-module `process.once`
// listeners that would leak across activate/deactivate cycles.

// Tracks the user-or-host-chosen "base" row separately from the row the
// renderer is currently showing. When `setRowTransient(row, ms)` is called
// we display `row` for `ms` then revert to `baseRow`. `setRow` overrides
// the base (so user-driven persistent state wins over a stale transient).
let baseRow: AnimationRow = "idle";
let transientTimer: NodeJS.Timeout | null = null;

/** Override stdout target. Used by tests; production uses process.stdout. */
export function setRendererStdout(stream: Writable): void {
  stdoutRef = stream;
}

/** Current protocol support snapshot. Useful for picker warnings. */
export function getProtocolSupport(): ProtocolSupport {
  return detectImageProtocol();
}

/**
 * Activate a pet with the given pre-extracted frames. Always tears
 * down any previous pet first so the terminal has at most one ambient
 * sprite registered with the renderer at a time.
 *
 * `rowLoader` is optional; pass it when the caller wants the renderer
 * to be able to swap animation rows later via `setRow()`. Without one,
 * the renderer stays on the initial frames forever.
 */
export function activateFrames(
  frames: ExtractedFrame[],
  options: { row?: AnimationRow; rowLoader?: RowLoader } = {},
): void {
  const support = detectImageProtocol();
  if (support.protocol === "none" || frames.length === 0) {
    deactivatePet();
    return;
  }
  deactivatePet();
  const initialRow = options.row ?? "idle";
  baseRow = initialRow;
  state = {
    frames,
    transmitted: new Set(),
    currentFrame: 0,
    frameStartedAt: Date.now(),
    protocol: support.protocol,
    row: initialRow,
    rowLoader: options.rowLoader ?? null,
  };
  schedule();
}

/**
 * Switch the active pet to a different animation row (e.g. transition
 * from "idle" to "running" when the agent starts a turn). No-op if the
 * row is already active, if no pet is active, or if no rowLoader was
 * supplied during activation.
 *
 * Caller wiring (future):
 *   - subscribe to host agent-state events
 *   - map "running" / "waiting-for-input" / etc. to the atlas row names
 *   - call `setRow(name)` on transitions
 */
/**
 * Internal row-switch primitive. Does NOT touch `baseRow` or
 * `transientTimer` — those are managed by the public `setRow` /
 * `setRowTransient` wrappers.
 */
async function setRowInternal(row: AnimationRow): Promise<void> {
  if (!state) return;
  if (state.row === row) return;
  if (!state.rowLoader) return;

  const next = await state.rowLoader(row);
  if (!next || next.length === 0) return;
  // Re-entrancy guard: another setRow may have completed while we were
  // awaiting the loader. Bail if state changed or evaporated.
  if (!state || state.row === row) return;

  // Delete the previous row's transmitted images so the terminal cache
  // doesn't grow across many row switches.
  for (const idx of state.transmitted) {
    try {
      stdoutRef.write(kittyDelete(AMBIENT_IMAGE_BASE + idx));
    } catch {
      // ignore
    }
  }
  state.frames = next;
  state.transmitted = new Set();
  state.currentFrame = 0;
  state.frameStartedAt = Date.now();
  state.row = row;
}

export async function setRow(row: AnimationRow): Promise<void> {
  baseRow = row;
  if (transientTimer) {
    clearTimeout(transientTimer);
    transientTimer = null;
  }
  await setRowInternal(row);
}

/**
 * Show `row` for `durationMs`, then revert to whatever the current
 * baseRow is (set by the most recent `setRow()` call, or the row
 * passed to `activateFrames`). Subsequent `setRowTransient` calls
 * before the timer fires replace the timer, so rapid event bursts
 * show only the latest transient row — desired behavior for
 * agent-event-driven animations (e.g. several failures in a row
 * just keep showing `failed` for one duration window).
 *
 * No-op if no pet is active or if the renderer has no row loader.
 */
export async function setRowTransient(row: AnimationRow, durationMs: number): Promise<void> {
  if (!state?.rowLoader) return;
  if (transientTimer) {
    clearTimeout(transientTimer);
    transientTimer = null;
  }
  await setRowInternal(row);
  transientTimer = setTimeout(() => {
    transientTimer = null;
    // baseRow may have changed during the transient window (e.g. a
    // long-running tool got cancelled and we want idle again); pull
    // the latest value here, not the value at schedule time.
    void setRowInternal(baseRow);
  }, durationMs);
  if (typeof transientTimer.unref === "function") transientTimer.unref();
}

/** Tear down the current pet. Safe to call multiple times. */
export function deactivatePet(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (transientTimer) {
    clearTimeout(transientTimer);
    transientTimer = null;
  }
  if (state) {
    // Delete every image id we transmitted this session so the
    // terminal doesn't keep them in its cache after we go away.
    for (const idx of state.transmitted) {
      try {
        stdoutRef.write(kittyDelete(AMBIENT_IMAGE_BASE + idx));
      } catch {
        // Terminal already gone — ignore.
      }
    }
    state = null;
  }
}

function schedule(): void {
  if (timer) return;
  tick();
  timer = setInterval(tick, REPLACE_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

function tick(): void {
  if (!state) return;
  const cols = (stdoutRef as NodeJS.WriteStream).columns ?? 80;
  const rows = (stdoutRef as NodeJS.WriteStream).rows ?? 24;
  const x = Math.max(1, cols - SPRITE_RESERVED_COLUMNS - RIGHT_MARGIN_COLS + 1);
  const y = Math.max(1, rows - SPRITE_ROWS - BOTTOM_MARGIN_ROWS + 1);

  // Advance frame if the current one has expired. Play-once semantics:
  // once we reach the last frame we hold there until the next setRow /
  // setRowTransient call swaps in a fresh animation. Looping made the
  // pet look like it was having a fit — every row would cycle forever
  // even when the underlying event (e.g. "wave once") was a one-shot.
  const now = Date.now();
  const elapsed = now - state.frameStartedAt;
  const current = state.frames[state.currentFrame];
  const atLastFrame = state.currentFrame >= state.frames.length - 1;
  if (current && elapsed >= current.durationMs && !atLastFrame) {
    const prevIdx = state.currentFrame;
    state.currentFrame = state.currentFrame + 1;
    state.frameStartedAt = now;
    // Kitty stacks placements at the same cells. Without this delete the
    // previous frame's placement stays on screen underneath the new one,
    // and any transparent pixels in the new frame let the old one bleed
    // through — looks like motion trails that only clear when the row
    // switches (which triggers the deactivate-style full delete below).
    // keepData: true preserves the cached image so the next cycle's a=p
    // re-place stays cheap; we only fully free on row switch / deactivate.
    try {
      stdoutRef.write(kittyDelete(AMBIENT_IMAGE_BASE + prevIdx, { keepData: true }));
    } catch {
      // ignore — stdout failures get caught by the transmit block below
    }
  }

  const idx = state.currentFrame;
  const frame = state.frames[idx];
  if (!frame) return;
  const imageId = AMBIENT_IMAGE_BASE + idx;
  const firstShow = !state.transmitted.has(idx);

  try {
    const payload = firstShow ? transmitFrame(frame.path, imageId, state.protocol) : replaceFrame(imageId);
    if (!payload) return;
    stdoutRef.write(withSavedCursor(x, y, payload));
    if (firstShow) state.transmitted.add(idx);
  } catch {
    // Reading the PNG or writing to stdout failed; drop state so we
    // don't keep failing on every tick.
    deactivatePet();
  }
}

function transmitFrame(pngPath: string, imageId: number, protocol: ImageProtocol): string | null {
  switch (protocol) {
    case "kitty":
      return kittyTransmitInline(pngPath, imageId, null, SPRITE_ROWS);
    case "kitty-local-file":
      return kittyTransmitLocalFile(pngPath, imageId, null, SPRITE_ROWS);
    case "none":
      return null;
  }
}

function replaceFrame(imageId: number): string {
  // a=p means "display an already-transmitted image". `r` repeats the row
  // count; `c` stays omitted so the terminal keeps deriving the width from
  // the sprite's aspect ratio, exactly as it did on transmit. q=2 suppresses
  // the terminal's OK reply.
  return `\x1b_Ga=p,i=${imageId},r=${SPRITE_ROWS},q=2;\x1b\\`;
}

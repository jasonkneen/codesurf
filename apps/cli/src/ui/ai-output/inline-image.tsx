// InlineImage — terminal-native image renderer for user-pasted screenshots.
//
// Uses the Kitty graphics protocol (same as the /pets renderer) when the
// terminal supports it. The terminal scales the PNG at its real pixel
// resolution, which is what makes pets look crisp — versus the previous
// supersample buffer path that dithered the image into cells and produced
// a blurry, half-block-art look.
//
// Architecture mirrors src/core/plugins/builtin/pets/renderer.ts:
//
//   - Decode + resize source via sharp into a temp PNG sized to the target
//     cell footprint × the terminal's reported pixel size per cell.
//   - Transmit once with a stable image id (a=T,i=<id>,q=2,f=100).
//   - Re-place with a=p,i=<id>,c=<C>,r=<R> from a post-process hook on each
//     rendered frame — OpenTUI paints over the image cells when it redraws,
//     so we re-emit the placement escape to survive. Moves delete only the
//     placement (keepData); the PNG bytes are never re-sent.
//   - Cursor position pulled from renderAfter's `this.screenX/screenY` ref
//     so the image follows the box as the user scrolls the message list.
//   - Cleanup on unmount / src change: kittyDelete (temp PNG stays cached).
//
// On terminals without Kitty graphics support (Apple Terminal, Alacritty,
// older iTerm2 without graphics protocol enabled) we fall back to the
// previous supersample renderer so the image is still visible — just at
// the lower half-block-style quality.
//
// Image id space: 0xE000 + counter. Pets use 0xC0DE base, so there's no
// collision when an ambient pet is active alongside inline screenshots.
//
// Slot reservation: while loading/error the box reserves `maxHeightCells`
// (dimensions unknown); once decoded it shrinks to the image's true
// `cellHeight` so wide-short screenshots don't leave a tall empty gap. The
// message-list virtualizer reads the same decoded height via
// `estimateInlineImageRows`, so its prefix-sum stays in lockstep with the
// rendered height across loading → ready transitions (the original flicker fix
// in 352070d kept these equal by pinning both to maxHeightCells; we now keep
// them equal by sharing the decoded height instead).

import { ptr } from "bun:ffi";
import { existsSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OptimizedBuffer } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import sharp from "sharp";
import {
  detectImageProtocol,
  kittyDelete,
  kittyTransmitInline,
  kittyTransmitLocalFile,
  withSavedCursor,
} from "../../core/plugins/builtin/pets/protocol";
import { normalizeLocalPathText } from "../local-file-paths";
import type { Theme } from "../theme";
import { inlineImageCacheKey, pruneInlineImageCache } from "./inline-image-cache";

export interface InlineImageProps {
  /** Filesystem path to the source image (PNG, JPEG, GIF, WebP, etc). */
  src: string;
  /** Cap the rendered cell width. Default 60. */
  maxWidthCells?: number;
  /** Cap the rendered cell height. Default 16. */
  maxHeightCells?: number;
  /** Theme — used only for the loading / error placeholder text. */
  t: Theme;
}

// ---------- Image-id allocator ---------------------------------------------
//
// Each InlineImage instance gets a stable image id assigned at mount. We use
// a monotonic counter starting at 0xE000 (well clear of pets at 0xC0DE).
// Module-level state — fine because there's a single TUI process per session.
let nextImageId = 0xe000;
function allocateImageId(): number {
  const id = nextImageId;
  nextImageId = nextImageId + 1;
  if (nextImageId > 0xefff) nextImageId = 0xe000; // wrap; >4096 inline images per session is unreasonable
  return id;
}

// ---------- Scrollbox clip rect ---------------------------------------------
//
// Kitty graphics are painted by the terminal ABOVE OpenTUI's text layer and do
// NOT respect the message-list scrollbox's clip rectangle. Without a guard, an
// image whose box scrolls above the list top gets clamped to row 1 (pinned to
// the top of the screen) and one whose box extends past the list bottom paints
// over the composer/footer (which lives outside the scrollbox). MessageList
// publishes the scrollbox's absolute screen bounds here every frame; the
// re-place loop only draws when the image box is fully inside them, and clears
// the placement otherwise. Module-level because there is one message-list
// scrollbox per TUI process (same rationale as the image-id allocator above).
let inlineImageClip: { top: number; bottom: number } = { top: 0, bottom: Number.POSITIVE_INFINITY };
let inlineImageSuppressed = false;

/** Publish the scrollbox's absolute screen-space vertical clip bounds. */
export function setInlineImageClipBounds(top: number, bottom: number): void {
  if (inlineImageClip.top === top && inlineImageClip.bottom === bottom) return;
  inlineImageClip = { top, bottom };
}

/** Suppress terminal-native image placement while a full-screen overlay is open. */
export function setInlineImageSuppressed(suppressed: boolean): void {
  inlineImageSuppressed = suppressed;
}

// Decoded cell-heights, keyed by normalized src, populated on first decode.
// The message-list virtualizer reads this (via estimateInlineImageRows) to
// reserve an image's TRUE row count instead of assuming the max slot — which
// over-reserved ~14 rows for wide-short screenshots (the "massive gap"). Keeping
// the estimate in lockstep with the rendered height avoids the prefix-sum drift
// the old fixed-height reservation was protecting against.
const cellHeightBySrc = new Map<string, number>();

/** Transcript rows reserved for an inline image: decoded cell-height + 1 for the
 *  container margin-bottom, or `fallback` before the first decode populates it. */
export function estimateInlineImageRows(src: string, fallback = 17): number {
  const h = cellHeightBySrc.get(normalizeLocalPathText(src));
  return h === undefined ? fallback : h + 1;
}

// ---------- Sharp-resized PNG cache ----------------------------------------
//
// Mirror pets/frames.ts cache style. Keyed by sha1 of src + source mtime/size
// + sizing (see inline-image-cache.ts) so an overwritten source never serves a
// stale preview and different sizing requests don't collide. Cache files are
// PNG so kittyTransmitLocalFile (kitty/ghostty) can reference them by path
// without re-uploading bytes. Pruned by age/count once per process.
const CACHE_ROOT = join(homedir(), ".grok", "inline-image-cache");
mkdirSync(CACHE_ROOT, { recursive: true });
let cachePruned = false;

interface SizedImage {
  /** Temp PNG path the renderer transmits / references. */
  pngPath: string;
  /** Terminal cell footprint (passed as c=, r= to Kitty). */
  cellWidth: number;
  cellHeight: number;
}

async function decodeAndResizeForKitty(
  src: string,
  maxWidthCells: number,
  maxHeightCells: number,
  cellPxW: number,
  cellPxH: number,
): Promise<SizedImage> {
  // Aspect-fit into the cell-derived pixel box. Kitty will scale to (c×r)
  // cells anyway, but we resize first so the wire bytes stay small (a 4K
  // screenshot is ~10 MB; we want ~50 KB on the wire).
  const targetPxW = maxWidthCells * cellPxW;
  const targetPxH = maxHeightCells * cellPxH;

  if (!cachePruned) {
    cachePruned = true;
    pruneInlineImageCache(CACHE_ROOT);
  }
  const cacheKey = inlineImageCacheKey(src, statSync(src), { maxWidthCells, maxHeightCells, cellPxW, cellPxH });
  const pngPath = join(CACHE_ROOT, `${cacheKey}.png`);

  let meta: { width?: number; height?: number };
  if (existsSync(pngPath)) {
    meta = await sharp(pngPath).metadata();
    try {
      // Refresh mtime so pruning evicts least-recently-used entries first.
      const now = new Date();
      utimesSync(pngPath, now, now);
    } catch {
      // best-effort
    }
  } else {
    const result = await sharp(src)
      .resize(targetPxW, targetPxH, { fit: "inside", withoutEnlargement: false })
      .png()
      .toFile(pngPath);
    meta = { width: result.width, height: result.height };
  }

  const pxW = meta.width ?? targetPxW;
  const pxH = meta.height ?? targetPxH;
  // Cells the terminal will paint into. Round up so the image isn't clipped.
  const cellWidth = Math.max(1, Math.min(maxWidthCells, Math.ceil(pxW / cellPxW)));
  const cellHeight = Math.max(1, Math.min(maxHeightCells, Math.ceil(pxH / cellPxH)));

  return { pngPath, cellWidth, cellHeight };
}

// ---------- Supersample fallback (legacy path) -----------------------------
//
// Kept verbatim from the prior renderer so terminals without Kitty graphics
// still see *something* — just at the lower half-block-art quality. Same
// alignment / aligned-row-bytes contract as before.

interface DecodedRaster {
  pixels: Uint8Array;
  pxWidth: number;
  pxHeight: number;
  alignedBytesPerRow: number;
  cellWidth: number;
  cellHeight: number;
}

const FALLBACK_CELL_PX_W = 9;
const FALLBACK_CELL_PX_H = 18;
const ROW_BYTE_ALIGNMENT = 256;
const BYTES_PER_PIXEL = 4;

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

async function decodeAndResizeForSupersample(
  src: string,
  maxWidthCells: number,
  maxHeightCells: number,
  cellPxW: number,
  cellPxH: number,
): Promise<DecodedRaster> {
  const targetPxW = maxWidthCells * cellPxW;
  const targetPxH = maxHeightCells * cellPxH;
  const { data, info } = await sharp(src)
    .resize(targetPxW, targetPxH, { fit: "inside", withoutEnlargement: false })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pxWidth = info.width;
  const pxHeight = info.height;
  const unalignedRowBytes = pxWidth * BYTES_PER_PIXEL;
  const alignedBytesPerRow = alignUp(unalignedRowBytes, ROW_BYTE_ALIGNMENT);

  const pixels = new Uint8Array(alignedBytesPerRow * pxHeight);
  for (let y = 0; y < pxHeight; y++) {
    const srcOffset = y * unalignedRowBytes;
    const dstOffset = y * alignedBytesPerRow;
    pixels.set(data.subarray(srcOffset, srcOffset + unalignedRowBytes), dstOffset);
  }

  const effectivePxWidth = alignedBytesPerRow / BYTES_PER_PIXEL;
  const cellWidth = Math.max(1, Math.ceil(effectivePxWidth / cellPxW));
  const cellHeight = Math.max(1, Math.ceil(pxHeight / cellPxH));
  return { pixels, pxWidth, pxHeight, alignedBytesPerRow, cellWidth, cellHeight };
}

// ---------- Component ------------------------------------------------------

type State =
  | { kind: "loading" }
  | { kind: "ready-kitty"; image: SizedImage }
  | { kind: "ready-supersample"; image: DecodedRaster }
  | { kind: "error"; message: string };

export function InlineImage({ src, maxWidthCells = 60, maxHeightCells = 16, t }: InlineImageProps) {
  const normalizedSrc = useMemo(() => normalizeLocalPathText(src), [src]);
  const renderer = useRenderer();
  const { cellPxW, cellPxH } = useMemo(() => {
    const res = renderer.resolution;
    const cols = renderer.terminalWidth || 80;
    const rows = renderer.terminalHeight || 24;
    if (res && res.width > 0 && res.height > 0 && cols > 0 && rows > 0) {
      return {
        cellPxW: Math.max(4, Math.floor(res.width / cols)),
        cellPxH: Math.max(8, Math.floor(res.height / rows)),
      };
    }
    return { cellPxW: FALLBACK_CELL_PX_W, cellPxH: FALLBACK_CELL_PX_H };
  }, [renderer.resolution, renderer.terminalWidth, renderer.terminalHeight]);

  const protocolSupport = useMemo(() => detectImageProtocol(), []);
  const supportsKitty = protocolSupport.protocol !== "none";

  const [state, setState] = useState<State>({ kind: "loading" });

  // Latest screen-space coords for the box, updated by renderAfter. Read by
  // the post-process placement hook so the image follows the box on scroll without
  // any React re-renders.
  const positionRef = useRef<{ x: number; y: number } | null>(null);
  // Last position we placed the kitty image at (null = no placement on
  // screen). When this differs from positionRef the image has moved (scroll)
  // — we must delete the old placement and re-place at the new position,
  // otherwise the terminal keeps the old placement around (ghost trails).
  const lastPlacedPosRef = useRef<{ x: number; y: number } | null>(null);
  // True once renderAfter has painted the box in the frame currently being
  // rendered; the post-process hook consumes and resets it each frame. When
  // OpenTUI stops painting the box (scrolled out), it stays false and the
  // placement is cleared so the image doesn't linger as a ghost.
  const seenThisFrameRef = useRef(false);
  const transmittedRef = useRef(false);
  const imageIdRef = useRef<number | null>(null);

  // ---- Decode/resize on mount ------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    transmittedRef.current = false;

    if (supportsKitty) {
      decodeAndResizeForKitty(normalizedSrc, maxWidthCells, maxHeightCells, cellPxW, cellPxH).then(
        (image) => {
          if (cancelled) return;
          cellHeightBySrc.set(normalizedSrc, image.cellHeight);
          setState({ kind: "ready-kitty", image });
        },
        (err: unknown) => {
          if (cancelled) return;
          setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        },
      );
    } else {
      decodeAndResizeForSupersample(normalizedSrc, maxWidthCells, maxHeightCells, cellPxW, cellPxH).then(
        (image) => {
          if (cancelled) return;
          cellHeightBySrc.set(normalizedSrc, image.cellHeight);
          setState({ kind: "ready-supersample", image });
        },
        (err: unknown) => {
          if (cancelled) return;
          setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [normalizedSrc, maxWidthCells, maxHeightCells, cellPxW, cellPxH, supportsKitty]);

  // ---- Kitty re-place loop ---------------------------------------------
  //
  // Runs only when we have a kitty-protocol image. Hooked as a post-process
  // step, so it fires once per rendered frame AFTER the tree has painted and
  // renderAfter has recorded this frame's position — no requestLive, so an
  // idle transcript does not keep the renderer spinning. The PNG bytes are
  // transmitted once; moves and scroll-outs only delete the placement
  // (keepData) and re-place by id, never re-sending the image data.
  useEffect(() => {
    if (state.kind !== "ready-kitty") return;

    const imageId = allocateImageId();
    imageIdRef.current = imageId;
    transmittedRef.current = false;
    lastPlacedPosRef.current = null;
    const { image } = state;
    const protocol = protocolSupport.protocol;

    // Remove the on-screen placement but keep the image data in the
    // terminal so re-placing later is a cheap a=p.
    const clearPlacement = () => {
      if (!lastPlacedPosRef.current) return;
      try {
        process.stdout.write(kittyDelete(imageId, { keepData: true }));
      } catch {
        // best-effort
      }
      lastPlacedPosRef.current = null;
    };

    const place = (_buffer: OptimizedBuffer): void => {
      const seen = seenThisFrameRef.current;
      seenThisFrameRef.current = false;
      const pos = positionRef.current;

      // Suppressed by an overlay, or the box was not painted this frame
      // (scrolled out of view / culled) → clear the placement.
      if (inlineImageSuppressed || !seen || !pos) {
        clearPlacement();
        return;
      }

      // Kitty placements ignore the scrollbox clip rect, so gate on it here.
      // Fully inside the list viewport → draw. Otherwise (scrolled above the
      // top, or extending past the bottom into the footer) → clear and bail,
      // never clamp-and-draw (that produced the pinned-to-top + footer-occlusion
      // bugs).
      const imgTop = pos.y;
      const imgBottom = pos.y + image.cellHeight;
      const fullyVisible = imgTop >= inlineImageClip.top && imgBottom <= inlineImageClip.bottom;
      if (!fullyVisible) {
        clearPlacement();
        return;
      }

      const x1 = Math.max(1, pos.x + 1);
      const y1 = Math.max(1, pos.y + 1);
      const lastPlaced = lastPlacedPosRef.current;

      // Moved (scroll) → drop the old placement first or kitty keeps the
      // image at the old cells too (ghost trail). Data stays resident.
      if (lastPlaced && (lastPlaced.x !== pos.x || lastPlaced.y !== pos.y)) {
        clearPlacement();
      }

      let payload: string;
      if (!transmittedRef.current) {
        if (protocol === "kitty-local-file") {
          payload = kittyTransmitLocalFile(image.pngPath, imageId, image.cellWidth, image.cellHeight);
        } else if (protocol === "kitty") {
          payload = kittyTransmitInline(image.pngPath, imageId, image.cellWidth, image.cellHeight);
        } else {
          return;
        }
        transmittedRef.current = true;
      } else {
        // a=p re-display by id. Cheap escape; no PNG bytes on the wire.
        // Re-emitted on each rendered frame because OpenTUI repaints cells
        // over the image.
        payload = `\x1b_Ga=p,i=${imageId},c=${image.cellWidth},r=${image.cellHeight},q=2;\x1b\\`;
      }
      try {
        process.stdout.write(withSavedCursor(x1, y1, payload));
        lastPlacedPosRef.current = { x: pos.x, y: pos.y };
      } catch {
        // Terminal closed mid-write — give up silently.
      }
    };
    renderer.addPostProcessFn(place);
    // Paint once so the first placement happens without waiting for an
    // unrelated re-render.
    renderer.requestRender();

    return () => {
      renderer.removePostProcessFn(place);
      try {
        process.stdout.write(kittyDelete(imageId));
      } catch {
        // best-effort
      }
      // Note: we leave the temp PNG on disk so re-mounting the same image
      // (e.g. after a session restore) hits the sharp cache instead of
      // re-decoding. The cache is pruned by age/count (inline-image-cache.ts).
      imageIdRef.current = null;
      transmittedRef.current = false;
      lastPlacedPosRef.current = null;
    };
  }, [state, protocolSupport.protocol, renderer]);

  // ---- Renderless placeholder for loading / error ----------------------
  //
  // Reserve the full vertical slot at all three states so the message-list
  // virtualizer's prefix-sum estimator sees a stable item height. Without
  // this the box collapses during decode and the estimator drifts (flicker).
  if (state.kind === "loading") {
    return (
      <box height={maxHeightCells} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={t.textMuted}>{`[image] loading ${shortenPath(normalizedSrc)}...`}</text>
      </box>
    );
  }
  if (state.kind === "error") {
    return (
      <box height={maxHeightCells} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={t.diffRemovedFg}>{`[image] failed: ${state.message}`}</text>
      </box>
    );
  }

  // ---- Ready: Kitty path -----------------------------------------------
  if (state.kind === "ready-kitty") {
    const { image } = state;
    // Box height tracks the DECODED cell-height (already clamped to
    // maxHeightCells during decode) so wide-short images don't reserve the full
    // slot and leave a large empty gap below the image. The message-list
    // virtualizer reads the same decoded height via estimateInlineImageRows, so
    // its prefix-sum stays in sync. The renderAfter callback only records
    // position — actual drawing is handled by the post-process hook above,
    // which writes raw kitty escapes to stdout.
    return (
      <box
        width={image.cellWidth}
        height={image.cellHeight}
        flexShrink={0}
        // Same callback shape as the supersample branch — we just ignore the
        // buffer arg. Writing to stdout happens in the post-process hook
        // above so we don't fight OpenTUI's frame buffer.
        renderAfter={function recordPosition(this: { screenX: number; screenY: number }, _buffer: OptimizedBuffer) {
          positionRef.current = { x: this.screenX, y: this.screenY };
          seenThisFrameRef.current = true;
        }}
      />
    );
  }

  // ---- Ready: supersample fallback -------------------------------------
  const { image } = state;
  return (
    <box
      width={image.cellWidth}
      height={image.cellHeight}
      flexShrink={0}
      renderAfter={function renderImage(this: { screenX: number; screenY: number }, buffer: OptimizedBuffer) {
        if (inlineImageSuppressed) return;
        try {
          buffer.drawSuperSampleBuffer(
            this.screenX,
            this.screenY,
            ptr(image.pixels),
            image.pixels.byteLength,
            "rgba8unorm",
            image.alignedBytesPerRow,
          );
        } catch {
          // Defensive — terminal resize mid-frame can reject the buffer.
        }
      }}
    />
  );
}

function shortenPath(p: string): string {
  if (p.length <= 40) return p;
  return `…${p.slice(-39)}`;
}

// ---------- Image-path extraction ----------------------------------------
// Lives in image-paths.ts (sharp/ffi-free so it is unit-testable); re-exported
// here for existing importers.
export { extractImagePaths, stripImagePaths } from "./image-paths";

// Suppress unused-import warnings on builds where the supersample path is
// dead-stripped — `ptr` is only used inside the fallback branch.
void ptr;

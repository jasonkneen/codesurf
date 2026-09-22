// Terminal image protocol helpers for ambient pets.
//
// MVP scope: Kitty graphics only. Sixel + auto-probe deferred. Detection is
// env-based (TERM, TERM_PROGRAM, KITTY_WINDOW_ID, WEZTERM_PANE) — fast and
// reliable enough for the major modern emulators, no terminal round-trips
// required at startup.
//
// Mirrors codex-rs/tui/src/pets/image_protocol.rs at a much smaller scope:
// transmit-with-id (a=T,i=...,q=2,f=100,t=f) + delete-by-id (a=d,d=I,i=...,q=2).

import { readFileSync } from "node:fs";

export type ImageProtocol = "kitty" | "kitty-local-file" | "none";

export interface ProtocolSupport {
  protocol: ImageProtocol;
  /** Human-readable hint shown when image rendering is unsupported. */
  unsupportedReason?: string;
}

const KITTY_TERMS = new Set(["xterm-kitty", "xterm-ghostty", "ghostty", "wezterm"]);

/**
 * Decide which image protocol to use. Cheap env-based heuristic, no terminal
 * round-trip. Conservative: when in doubt we return "none" so the rest of the
 * pets module degrades to a text-only state instead of garbling stdout.
 */
export function detectImageProtocol(env: NodeJS.ProcessEnv = process.env): ProtocolSupport {
  // Explicit opt-out for tests / users who hate it.
  if (env.CODESURF_PETS_DISABLED === "1" || env.GROK_PETS_DISABLED === "1") {
    return { protocol: "none", unsupportedReason: "disabled via CODESURF_PETS_DISABLED" };
  }

  const term = (env.TERM ?? "").toLowerCase();
  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();

  // Strong positives: terminal advertises itself unambiguously.
  if (env.KITTY_WINDOW_ID) {
    // Kitty itself supports local-file references — saves ~30% of bytes per
    // frame transmit since we skip base64 encoding the PNG.
    return { protocol: "kitty-local-file" };
  }
  if (env.GHOSTTY_RESOURCES_DIR || termProgram === "ghostty") {
    return { protocol: "kitty-local-file" };
  }
  if (env.WEZTERM_PANE || termProgram === "wezterm") {
    // WezTerm's kitty support doesn't include the local-file shortcut; fall
    // back to inline base64.
    return { protocol: "kitty" };
  }

  if (KITTY_TERMS.has(term)) {
    return { protocol: "kitty" };
  }

  return {
    protocol: "none",
    unsupportedReason: "no Kitty graphics protocol detected (set TERM=xterm-kitty or run in kitty/ghostty/wezterm)",
  };
}

const ESC = "\x1b";

/**
 * Build a Kitty graphics escape sequence that transmits and displays a PNG at
 * the current cursor position with a stable image id. Caller is responsible
 * for positioning the cursor first and restoring it after.
 *
 * The sequence is split into 4096-byte chunks per the Kitty protocol spec.
 *
 * `columns` may be `null`, which omits the `c=` key. That matters: when BOTH
 * `c` and `r` are sent the terminal scales the image to fill that exact cell
 * rectangle and ignores the source aspect ratio (see ghostty
 * `src/terminal/kitty/graphics_storage.zig`, `calculatedSize`: "If we have a
 * specified cols AND rows then we calculate the width and height from them
 * directly, we don't need to adjust for aspect ratio"). Sending only `r` makes
 * the terminal derive the width from the image's aspect ratio using the cell
 * size it knows and we don't.
 */
export function kittyTransmitInline(pngPath: string, imageId: number, columns: number | null, rows: number): string {
  const bytes = readFileSync(pngPath);
  const base64 = bytes.toString("base64");
  return chunkKittyPayload(base64, {
    action: "T",
    imageId,
    format: 100, // PNG
    columns,
    rows,
    transmissionMedium: "d", // direct (inline base64)
  });
}

/**
 * Kitty graphics by file reference (a=T,t=f). Saves the base64 round-trip.
 * Only safe on terminals that share a filesystem with the client — kitty,
 * ghostty. Not WezTerm.
 */
export function kittyTransmitLocalFile(pngPath: string, imageId: number, columns: number | null, rows: number): string {
  // For t=f the "payload" is a base64-encoded absolute path.
  const pathPayload = Buffer.from(pngPath, "utf8").toString("base64");
  return chunkKittyPayload(pathPayload, {
    action: "T",
    imageId,
    format: 100,
    columns,
    rows,
    transmissionMedium: "f", // file path
  });
}

/**
 * Delete-by-id. Quiet (q=2) so the terminal doesn't echo OK back.
 *
 * By default frees the image data (`d=I`). Pass `{ keepData: true }` to clear
 * only the on-screen placement while leaving the image cached — useful between
 * animation frames so the next `a=p` re-place stays cheap.
 */
export function kittyDelete(imageId: number, opts: { keepData?: boolean } = {}): string {
  const action = opts.keepData ? "i" : "I";
  return `${ESC}_Ga=d,d=${action},i=${imageId},q=2;${ESC}\\`;
}

interface ChunkOptions {
  action: "T";
  imageId: number;
  format: number;
  /** `null` omits `c=` so the terminal preserves the source aspect ratio. */
  columns: number | null;
  rows: number;
  transmissionMedium: "d" | "f";
}

const CHUNK_SIZE = 4096;

function chunkKittyPayload(payload: string, opts: ChunkOptions): string {
  const out: string[] = [];
  let offset = 0;
  let first = true;
  while (offset < payload.length || first) {
    const slice = payload.slice(offset, offset + CHUNK_SIZE);
    offset += CHUNK_SIZE;
    const more = offset < payload.length ? 1 : 0;
    const controls: string[] = [];
    if (first) {
      controls.push(`a=${opts.action}`);
      controls.push(`t=${opts.transmissionMedium}`);
      controls.push(`f=${opts.format}`);
      if (opts.columns !== null) controls.push(`c=${opts.columns}`);
      controls.push(`r=${opts.rows}`);
      controls.push(`q=2`);
      controls.push(`i=${opts.imageId}`);
      first = false;
    } else {
      controls.push(`q=2`);
      controls.push(`i=${opts.imageId}`);
    }
    controls.push(`m=${more}`);
    out.push(`${ESC}_G${controls.join(",")};${slice}${ESC}\\`);
    if (!more) break;
  }
  return out.join("");
}

/**
 * Cursor save / move / restore wrapper. Centralised so we never forget the
 * RestorePosition — the codex-rs equivalent uses crossterm SavePosition /
 * MoveTo / RestorePosition for the same reason. Coordinates are 1-based per
 * VT100 convention.
 */
export function withSavedCursor(x1Based: number, y1Based: number, payload: string): string {
  return `${ESC}7${ESC}[${y1Based};${x1Based}H${payload}${ESC}8`;
}

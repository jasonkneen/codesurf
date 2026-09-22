// Vitest-only stub for `@opentui/core`, which is Bun-native (bun:ffi zig
// bindings, Bun file-loader .scm/.wasm imports) and cannot load under Node.
// Wired via `resolve.alias` in vitest.config.ts.
//
// Only the names src/ imports at runtime are provided (RGBA, SyntaxStyle,
// TextBufferRenderable, decodePasteBytes, parseKeypress) — enough for module
// graphs to load and for non-rendering logic to run. Tests that exercise real
// TUI rendering are Bun-native (`bun test`) and never see this stub. If a new
// runtime import appears in src/, vitest fails loudly with a missing-export
// error — extend the stub then.

export class RGBA {
  constructor(
    public r = 0,
    public g = 0,
    public b = 0,
    public a = 1,
  ) {}

  static fromHex(hex: string): RGBA {
    const clean = hex.replace("#", "");
    const n = Number.parseInt(clean.slice(0, 6).padEnd(6, "0"), 16);
    const a = clean.length >= 8 ? Number.parseInt(clean.slice(6, 8), 16) / 255 : 1;
    return new RGBA(((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255, a);
  }

  static fromInts(r: number, g: number, b: number, a = 255): RGBA {
    return new RGBA(r / 255, g / 255, b / 255, a / 255);
  }

  static fromValues(r: number, g: number, b: number, a = 1): RGBA {
    return new RGBA(r, g, b, a);
  }
}

export class SyntaxStyle {
  constructor(public readonly styles: Record<string, unknown> = {}) {}

  static fromStyles(styles: Record<string, unknown>): SyntaxStyle {
    return new SyntaxStyle(styles);
  }
}

export class TextBufferRenderable {
  isDestroyed = false;
  x = 0;
  y = 0;
}

export function decodePasteBytes(bytes: Uint8Array | string): string {
  return typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
}

export function parseKeypress(
  sequence: string | Buffer,
  _options?: { useKittyKeyboard?: boolean },
): Record<string, unknown> {
  return { name: String(sequence), sequence: String(sequence), ctrl: false, meta: false, shift: false };
}

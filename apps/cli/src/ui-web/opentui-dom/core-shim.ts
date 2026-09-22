// core-shim.ts — the few @opentui/core VALUES the component tree imports
// (RGBA, SyntaxStyle, decodePasteBytes, parseKeypress). Types are erased at build.
//
// RGBA and SyntaxStyle are not inert stubs: `src/ui/markdown.tsx` builds a real
// syntax style from the theme and hands it to `<markdown>`, and the web markdown
// renderer reads the colours back out of it. A stub that dropped them would give
// the browser an unthemed transcript — so both keep their values, in the one
// form the web side can use: CSS colour strings.

/** A colour that survives the round trip to CSS. */
export class RGBA {
  constructor(
    public r = 0,
    public g = 0,
    public b = 0,
    public a = 255,
  ) {}

  static white = new RGBA(255, 255, 255);
  static transparent = new RGBA(0, 0, 0, 0);

  static fromHex(hex: string): RGBA {
    const value = hex.replace("#", "");
    const expanded =
      value.length === 3
        ? value
            .split("")
            .map((c) => c + c)
            .join("")
        : value;
    const int = Number.parseInt(expanded.slice(0, 6), 16);
    if (Number.isNaN(int)) return new RGBA(0, 0, 0, 255);
    const alpha = expanded.length >= 8 ? Number.parseInt(expanded.slice(6, 8), 16) : 255;
    return new RGBA((int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff, alpha);
  }

  /** CSS form, which is the only form the DOM host has any use for. */
  toString(): string {
    return this.a >= 255
      ? `rgb(${this.r}, ${this.g}, ${this.b})`
      : `rgba(${this.r}, ${this.g}, ${this.b}, ${this.a / 255})`;
  }
}

export interface SyntaxStyleEntry {
  fg?: RGBA;
  bg?: RGBA;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/**
 * The theme's token styles, kept as a plain lookup.
 *
 * The terminal's SyntaxStyle compiles these for its own renderer; here they only
 * need to be readable by scope name, which is what the web markdown renderer
 * does (`markup.heading`, `markup.bold`, `code`, …).
 */
export class SyntaxStyle {
  private constructor(readonly styles: Record<string, SyntaxStyleEntry>) {}

  static fromStyles(styles: Record<string, SyntaxStyleEntry>): SyntaxStyle {
    return new SyntaxStyle(styles);
  }

  /** The style for a scope, falling back through `a.b.c` → `a.b` → `default`. */
  get(scope: string): SyntaxStyleEntry {
    let key = scope;
    while (key) {
      const found = this.styles[key];
      if (found) return found;
      const cut = key.lastIndexOf(".");
      if (cut < 0) break;
      key = key.slice(0, cut);
    }
    return this.styles.default ?? {};
  }
}

/**
 * Paste bytes → text.
 *
 * Not a stub any more: the composer's paste handler
 * (`use-composer-actions.handlePaste`) decodes the PasteEvent's bytes through
 * exactly this function, so the earlier `return ""` made every web paste
 * silently vanish. The DOM adapter's bytes are UTF-8 clipboard text (the
 * terminal's are the raw paste stream), so a TextDecoder decode is the whole
 * job — there are no bracketed-paste markers or ANSI sequences to strip on
 * this side.
 */
export function decodePasteBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function parseKeypress(_raw: unknown): {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  sequence: string;
} {
  return { name: "", ctrl: false, meta: false, shift: false, sequence: "" };
}

// ── Types ────────────────────────────────────────────────────────────────────
// The rest of the @opentui/core imports in src/ui are type-only (spec §2.2).
// They are erased at build time, but the shim still has to DECLARE them or the
// web build's module resolution fails on the import itself. Each interface
// below is the subset of the real class the component tree compiles against —
// wide enough for the call sites, no wider.

/**
 * One `<textarea>` key binding, e.g. `{ name: "return", shift: true, action:
 * "newline" }`. The real type is generic over the action union; every action
 * this tree declares is a plain string, and the DOM adapter only branches on
 * "submit"/"newline" because the browser already implements the rest.
 */
export interface KeyBinding {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  super?: boolean;
  action?: string;
}

/** The keyboard event, as 13 files branch on it. keys.ts's WebKeyEvent satisfies this. */
export interface KeyEvent {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  option: boolean;
  sequence: string;
  number: boolean;
  raw: string;
  code?: string;
  baseCode?: number;
  super?: boolean;
  repeated?: boolean;
  readonly defaultPrevented: boolean;
  readonly propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * The paste event the composer handlers consume: `bytes` decoded through
 * `decodePasteBytes`, `preventDefault()` when the paste becomes a paste-block
 * token. textarea.tsx's WebPasteEvent satisfies this.
 */
export interface PasteEvent {
  readonly type: "paste";
  readonly bytes: Uint8Array;
  readonly metadata?: { mimeType?: string; kind?: "text" | "binary" | "unknown" };
  readonly defaultPrevented: boolean;
  readonly propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * Mouse event in CELLS. `useComposerImageHover` reads `event.x - target.x` and
 * `event.y - target.y` as columns/rows to map the pointer to a text offset, so
 * the DOM adapter converts pixels before constructing this.
 */
export interface MouseEvent {
  readonly x: number;
  readonly y: number;
  readonly target?: { x?: number; y?: number; width?: number; height?: number } | null;
  preventDefault?(): void;
  stopPropagation?(): void;
}

/**
 * The imperative composer surface (24 call sites). textarea.tsx's facade
 * satisfies it; declared here so the 15 type-only imports
 * (`RefObject<TextareaRenderable | null>`) resolve in the web build.
 */
export interface TextareaRenderable {
  readonly plainText: string;
  cursorOffset: number;
  readonly focused: boolean;
  readonly lineCount: number;
  readonly logicalCursor: { row: number; col: number };
  setText(text: string): void;
  clear(): void;
  insertText(text: string): void;
  focus(): void;
  blur(): void;
  requestRender(): void;
}

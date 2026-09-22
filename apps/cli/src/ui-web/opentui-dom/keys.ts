// DOM KeyboardEvent -> OpenTUI's ParsedKey shape.
//
// The component tree branches on `key.name` ("return", "up", "escape", ...) and
// in several places on `key.sequence` (the raw bytes a terminal would have
// sent). Both have to be right: a web key event carrying only `name` silently
// breaks every `key.sequence === "\u001b"` check, and those are the escape and
// mode-switch paths.
//
// Names here are the terminal's, not the DOM's -- `Enter` is "return", not
// "enter", because that is what 38 call sites compare against.

export type KeyEventType = "press" | "repeat" | "release";

export interface ParsedKeyLike {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  option: boolean;
  sequence: string;
  number: boolean;
  raw: string;
  eventType: KeyEventType;
  source: "raw" | "kitty";
  code?: string;
  repeated?: boolean;
}

/** DOM `event.key` -> terminal name, for keys whose names differ. */
const NAMES: Record<string, string> = {
  Enter: "return",
  Escape: "escape",
  Backspace: "backspace",
  Tab: "tab",
  Delete: "delete",
  Insert: "insert",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  " ": "space",
};

const ESC = "\u001b";

/**
 * The bytes a terminal would have sent for this key.
 *
 * Only the ones the tree actually inspects need to be exact -- `\u001b` for
 * escape is compared directly in the input router. The rest fall back to the
 * character itself, which is what a terminal sends for printable keys.
 */
const SEQUENCES: Record<string, string> = {
  return: "\r",
  escape: ESC,
  backspace: "\u007f",
  tab: "\t",
  space: " ",
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  right: `${ESC}[C`,
  left: `${ESC}[D`,
  home: `${ESC}[H`,
  end: `${ESC}[F`,
  pageup: `${ESC}[5~`,
  pagedown: `${ESC}[6~`,
  delete: `${ESC}[3~`,
  insert: `${ESC}[2~`,
};

/**
 * A key event with the terminal's shape, including the two methods the tree
 * calls on it.
 *
 * `preventDefault` forwards to the DOM event so the browser does not also act
 * on the key -- without that, Tab moves focus out of the app and space scrolls
 * the page while a handler is trying to use them.
 */
export class WebKeyEvent implements ParsedKeyLike {
  readonly name: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly option: boolean;
  readonly sequence: string;
  readonly number: boolean;
  readonly raw: string;
  readonly eventType: KeyEventType;
  readonly source = "raw" as const;
  readonly code?: string;
  readonly repeated?: boolean;

  private prevented = false;
  private stopped = false;

  constructor(private readonly event: KeyboardEvent) {
    const key = event.key;
    // A single printable character keeps its lowercase form as the name --
    // `key.name === "x"` is how the tree matches letters, with shift carried
    // separately rather than by case.
    this.name = NAMES[key] ?? key.toLowerCase();
    this.sequence = SEQUENCES[this.name] ?? (key.length === 1 ? key : "");
    this.raw = this.sequence;
    this.ctrl = event.ctrlKey;
    this.meta = event.metaKey;
    this.shift = event.shiftKey;
    this.option = event.altKey;
    this.number = key.length === 1 && key >= "0" && key <= "9";
    this.eventType = event.type === "keyup" ? "release" : event.repeat ? "repeat" : "press";
    this.code = event.code;
    this.repeated = event.repeat;
  }

  get defaultPrevented(): boolean {
    return this.prevented;
  }

  get propagationStopped(): boolean {
    return this.stopped;
  }

  preventDefault(): void {
    this.prevented = true;
    this.event.preventDefault();
  }

  stopPropagation(): void {
    this.stopped = true;
    this.event.stopPropagation();
  }
}

export function toKeyEvent(event: KeyboardEvent): WebKeyEvent {
  return new WebKeyEvent(event);
}

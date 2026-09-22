/** @jsxImportSource react */
// `<textarea>` with a TextareaRenderable-shaped ref — the composer (P2).
//
// 24 call sites use the tag and reach through its ref: `plainText` on every
// submit, `setText`/`cursorOffset` for prompt-history recall, `insertText` for
// paste-block and file-mention tokens, `clear()` on commit, `focus()` when a
// modal closes. The adapter renders a REAL DOM <textarea> — the browser gives
// cursor, selection, multiline, IME and paste for free, and reimplementing any
// of those on a cell grid would be a worse editor, not a more faithful one.
// The ref object is a facade over the element: `plainText` ↔ `.value`,
// `cursorOffset` ↔ `.selectionStart`, and so on.
//
// The pragma above is load-bearing (see elements.tsx): host DOM tags in this
// file must use React's runtime, or `<textarea>` here would resolve back to
// this very component through the mapping runtime.

import {
  type CSSProperties,
  createElement,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyBinding, MouseEvent, PasteEvent, TextareaRenderable } from "./core-shim.js";
import { toKeyEvent } from "./keys.js";
import { cellWidth, rowHeight } from "./scrollbox.js";

/**
 * The element, reduced to what the facade reads.
 *
 * An interface rather than HTMLTextAreaElement so the facade arithmetic can be
 * tested against a stand-in node — the same reason ScrollNode exists in
 * scrollbox.tsx. HTMLTextAreaElement satisfies it structurally.
 */
export interface TextareaNode {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
  focus(): void;
  blur(): void;
}

/** The TextareaRenderable surface the component tree actually reaches for. */
export interface TextareaHandle extends TextareaRenderable {
  /** The underlying element, for anything this adapter does not cover. */
  readonly element: TextareaNode | null;
}

/**
 * Build the imperative facade over a DOM textarea.
 *
 * Exported separately from the component so the facade — the part every call
 * site touches through the ref — is reachable by tests without a renderer.
 *
 * `notify` fires the onContentChange / onCursorChange props on PROGRAMMATIC
 * mutation (setText/clear/insertText/cursorOffset=). The terminal's edit
 * buffer emits content-change on any mutation, user-typed or not, and the
 * typeahead's refresh listens to exactly that — a facade that stayed silent on
 * programmatic edits would leave the suggestion overlay stale after history
 * recall.
 */
export function makeTextareaHandle(
  node: () => TextareaNode | null,
  notify: { content(): void; cursor(): void },
  isFocused: () => boolean,
): TextareaHandle {
  return {
    get plainText() {
      return node()?.value ?? "";
    },
    get cursorOffset() {
      return node()?.selectionStart ?? 0;
    },
    set cursorOffset(offset: number) {
      const element = node();
      if (!element) return;
      const clamped = Math.max(0, Math.min(offset, element.value.length));
      element.setSelectionRange(clamped, clamped);
      notify.cursor();
    },
    get focused() {
      return isFocused();
    },
    get lineCount() {
      return (node()?.value ?? "").split("\n").length;
    },
    get logicalCursor() {
      // use-composer-keys reads `logicalCursor.row` to decide whether Up sits
      // on the first line (recall history) or mid-buffer (move the caret).
      const element = node();
      if (!element) return { row: 0, col: 0 };
      const before = element.value.slice(0, element.selectionStart);
      const row = before.split("\n").length - 1;
      return { row, col: before.length - (before.lastIndexOf("\n") + 1) };
    },
    setText(text: string) {
      const element = node();
      if (!element) return;
      // The terminal's setText resets the buffer AND drops undo history; the
      // DOM has no per-element undo stack to drop, so replacing the value is
      // the whole semantics. Caret lands at the end, matching the terminal.
      element.value = text;
      element.setSelectionRange(text.length, text.length);
      notify.content();
    },
    clear() {
      const element = node();
      if (!element) return;
      element.value = "";
      element.setSelectionRange(0, 0);
      notify.content();
    },
    insertText(text: string) {
      const element = node();
      if (!element) return;
      // Insert at the caret, replacing any selection — what the terminal's
      // edit buffer does, and what paste-block tokens rely on when the user
      // pastes over a selection.
      const start = element.selectionStart;
      const end = element.selectionEnd;
      element.value = element.value.slice(0, start) + text + element.value.slice(end);
      element.setSelectionRange(start + text.length, start + text.length);
      notify.content();
    },
    focus() {
      node()?.focus();
    },
    blur() {
      node()?.blur();
    },
    requestRender() {
      // No-op by construction: the DOM repaints itself. composer-context calls
      // this after clear() because the TERMINAL batches redraws; there is
      // nothing to flush here, and a fake flush would imply one exists.
    },
    get element() {
      return node();
    },
  };
}

/** The key fields a KeyBinding match consults. */
export interface TextareaKeyLike {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

/**
 * Data-driven lookup over the `keyBindings` prop.
 *
 * Modifier comparison is EXACT — a binding with no modifiers matches only the
 * bare key. That is what lets TEXTAREA_KEYBINDINGS carry `{return → submit}`
 * and `{return+shift → newline}` side by side: hardcoding "Enter submits"
 * would make Shift+Enter submit too, and the modal editors' bare
 * `[{return → submit}]` lists would gain a Shift+Enter behaviour nobody
 * declared.
 */
export function matchKeyBinding(bindings: readonly KeyBinding[], key: TextareaKeyLike): KeyBinding | undefined {
  return bindings.find(
    (b) =>
      b.name === key.name &&
      Boolean(b.shift) === key.shift &&
      Boolean(b.ctrl) === key.ctrl &&
      Boolean(b.meta) === key.meta,
  );
}

/**
 * The paste event, in the terminal's shape.
 *
 * Handlers in src/ui (`use-composer-actions.handlePaste`, the input router's
 * paste branch) read `event.bytes` through `decodePasteBytes`, branch on
 * `event.defaultPrevented`, and call `event.preventDefault()` when they turn a
 * multi-line paste into a paste-block token. The DOM side carries UTF-8
 * clipboard text instead of a raw terminal byte stream, so the bytes are a
 * TextEncoder product; `preventDefault` ALSO suppresses the DOM's own
 * insertion, or the raw text would land in the buffer next to the token.
 */
export class WebPasteEvent implements PasteEvent {
  readonly type = "paste" as const;
  readonly bytes: Uint8Array;
  readonly metadata = { mimeType: "text/plain", kind: "text" as const };
  private prevented = false;
  private stopped = false;

  constructor(
    text: string,
    private readonly domPreventDefault: () => void,
  ) {
    this.bytes = new TextEncoder().encode(text);
  }

  get defaultPrevented(): boolean {
    return this.prevented;
  }

  get propagationStopped(): boolean {
    return this.stopped;
  }

  preventDefault(): void {
    this.prevented = true;
    this.domPreventDefault();
  }

  stopPropagation(): void {
    this.stopped = true;
  }
}

type TextareaProps = {
  children?: ReactNode;
  ref?: React.Ref<TextareaHandle>;
  focused?: boolean;
  placeholder?: string;
  placeholderColor?: string;
  textColor?: string;
  focusedTextColor?: string;
  backgroundColor?: string;
  minHeight?: number;
  maxHeight?: number;
  wrapMode?: string;
  keyBindings?: readonly KeyBinding[];
  onSubmit?: (event: Record<string, never>) => void;
  onPaste?: (event: PasteEvent) => void;
  onContentChange?: (event: Record<string, never>) => void;
  onCursorChange?: (event: { line: number; visualColumn: number }) => void;
  onMouseMove?: (event: MouseEvent) => void;
  onMouseOut?: (event: MouseEvent) => void;
} & Record<string, unknown>;

export function Textarea({
  ref,
  focused,
  placeholder,
  placeholderColor,
  textColor,
  focusedTextColor,
  backgroundColor,
  minHeight = 1,
  maxHeight,
  wrapMode,
  keyBindings,
  onSubmit,
  onPaste,
  onContentChange,
  onCursorChange,
  onMouseMove,
  onMouseOut,
}: TextareaProps) {
  const element = useRef<HTMLTextAreaElement>(null);
  // Focus is mirrored into a ref (for the facade's `focused` getter, readable
  // outside React's commit phase) and state (for the focusedTextColor swap).
  const focusRef = useRef(false);
  const [hasFocus, setHasFocus] = useState(false);

  // The handlers the facade notifies, held in a ref so the imperative handle
  // can be built once ([]) without going stale — the same reason useKeyboard
  // keeps its handler in a ref.
  const callbacks = useRef({ onContentChange, onCursorChange });
  callbacks.current = { onContentChange, onCursorChange };

  const notify = useMemo(
    () => ({
      content: () => callbacks.current.onContentChange?.({}),
      cursor: () => {
        const el = element.current;
        if (!el) return;
        const before = el.value.slice(0, el.selectionStart);
        const line = before.split("\n").length - 1;
        callbacks.current.onCursorChange?.({ line, visualColumn: before.length - (before.lastIndexOf("\n") + 1) });
      },
    }),
    [],
  );

  useImperativeHandle(
    ref,
    () =>
      makeTextareaHandle(
        () => element.current,
        notify,
        () => focusRef.current,
      ),
    [notify],
  );

  // `focused={!captureOpen}` is how the tree blurs the composer when a modal
  // owns the keyboard; on web the DOM element must actually give up focus, or
  // it keeps inserting typed characters underneath the modal.
  useEffect(() => {
    const el = element.current;
    if (!el) return;
    if (focused) el.focus();
    else el.blur();
  }, [focused]);

  // `::placeholder` colour cannot be set inline; it needs a real rule. One
  // scoped style element per textarea, removed on unmount.
  const placeholderClass = `codesurf-ta-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  useEffect(() => {
    if (!placeholderColor) return;
    const rule = document.createElement("style");
    rule.textContent = `.${placeholderClass}::placeholder { color: ${placeholderColor}; }`;
    document.head.appendChild(rule);
    return () => rule.remove();
  }, [placeholderClass, placeholderColor]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Two orderings the terminal guarantees, reproduced here:
    // 1. Global handlers see the key FIRST (the shim's useKeyboard listens on
    //    window in the capture phase) and claim it with preventDefault — the
    //    typeahead accepting Enter, a modal taking Esc, Ctrl+X aborting. A
    //    claimed key must not ALSO act here, or Enter would submit the prompt
    //    while accepting a suggestion.
    // 2. Enter confirming an IME candidate is not a submit.
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const binding = matchKeyBinding(keyBindings ?? [], toKeyEvent(event.nativeEvent));
    if (!binding) return;
    if (binding.action === "submit") {
      event.preventDefault();
      onSubmit?.({});
    }
    // "newline" needs no code: the DOM's default action inserts the line
    // break. Every other action name (cursor moves, deletion, undo) is
    // already the browser's native textarea behaviour.
  };

  const onPasteEvent = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    if (!onPaste) return;
    const text = event.clipboardData?.getData("text") ?? "";
    onPaste(new WebPasteEvent(text, () => event.preventDefault()));
  };

  const mouseEventCells = (event: ReactMouseEvent<HTMLTextAreaElement>): MouseEvent | null => {
    const el = element.current;
    if (!el) return null;
    // useComposerImageHover maps the pointer back to a TEXT OFFSET assuming
    // cell coordinates (event.x - target.x in columns, y in rows), so pixels
    // would resolve to a block ~16x further along than the pointer is.
    const row = rowHeight(el);
    const column = cellWidth(el);
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(event.clientX / column),
      y: Math.round(event.clientY / row),
      target: {
        x: Math.round(rect.left / column),
        y: Math.round(rect.top / row),
        width: Math.round(rect.width / column),
        height: Math.round(rect.height / row),
      },
    };
  };

  const style: CSSProperties = {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    margin: 0,
    padding: 0,
    border: "none",
    outline: "none",
    resize: "none",
    // Stay on the cell grid: the page's monospace face and --row line-height,
    // or the composer drifts off every alignment the rest of the tree holds.
    font: "inherit",
    lineHeight: "inherit",
    color: (hasFocus ? focusedTextColor : undefined) ?? textColor,
    backgroundColor: backgroundColor ?? "transparent",
    minHeight: `calc(${minHeight} * var(--row))`,
    ...(maxHeight !== undefined ? { maxHeight: `calc(${maxHeight} * var(--row))` } : {}),
    // Grow with content between min and max height, as the terminal does.
    // `field-sizing` is Chrome 123+/Firefox 132+; elsewhere the box holds at
    // minHeight rows and scrolls past maxHeight — degraded, not broken.
    fieldSizing: "content",
  };

  // createElement, not JSX: vitest aliases `@opentui/react/jsx-runtime` to a
  // stub that returns `{type, props, key}` objects. The file pragma is not
  // honoured by that transform, so a JSX `<textarea>` would be an unmountable
  // object. createElement from `react` is a real DOM node in both vitest and
  // the web build.
  return createElement("textarea", {
    ref: element,
    className: placeholderClass,
    style,
    rows: minHeight,
    placeholder,
    wrap: wrapMode === "none" ? "off" : "soft",
    onFocus: () => {
      focusRef.current = true;
      setHasFocus(true);
    },
    onBlur: () => {
      focusRef.current = false;
      setHasFocus(false);
    },
    onKeyDown,
    onPaste: onPasteEvent,
    onChange: () => {
      notify.content();
      notify.cursor();
    },
    onKeyUp: () => notify.cursor(),
    onClick: () => notify.cursor(),
    onSelect: () => notify.cursor(),
    onMouseMove: onMouseMove
      ? (event: ReactMouseEvent<HTMLTextAreaElement>) => {
          const cells = mouseEventCells(event);
          if (cells) onMouseMove(cells);
        }
      : undefined,
    onMouseOut: onMouseOut
      ? (event: ReactMouseEvent<HTMLTextAreaElement>) => {
          const cells = mouseEventCells(event);
          if (cells) onMouseOut(cells);
        }
      : undefined,
  });
}

export const textarea = Textarea;

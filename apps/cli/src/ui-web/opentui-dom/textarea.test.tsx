// @vitest-environment jsdom
// The composer adapter: facade, key bindings, paste, focus.
//
// Two layers, mirroring scrollbox.test.tsx:
//   1. `makeTextareaHandle` driven over a STAND-IN node — the facade is the
//      part every call site touches through the ref, and it must hold without
//      a renderer.
//   2. The real component under jsdom — jsdom DOES give a textarea a value, a
//      caret, focus and events (unlike layout), so focus/submit/paste are
//      testable here; what it does NOT do is perform default editing actions
//      (a keydown never inserts a character), so tests assert against the
//      handler contract — called / not called / not preventDefaulted — rather
//      than against typed text.

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { KeyBinding } from "./core-shim.js";
import { decodePasteBytes } from "./core-shim.js";
import { makeTextareaHandle, matchKeyBinding, Textarea, type TextareaHandle, type TextareaNode } from "./textarea.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Facade over a stand-in node ──────────────────────────────────────────────

function node(initial = "") {
  const element: TextareaNode = {
    value: initial,
    selectionStart: 0,
    selectionEnd: 0,
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
    focus: vi.fn(),
    blur: vi.fn(),
  };
  const notify = { content: vi.fn(), cursor: vi.fn() };
  const focusState = { value: false };
  const handle = makeTextareaHandle(
    () => element,
    notify,
    () => focusState.value,
  );
  return { element, notify, focusState, handle };
}

describe("textarea facade", () => {
  it("round-trips plainText through setText and clear", () => {
    const { element, handle } = node();
    handle.setText("hello world");
    expect(element.value).toBe("hello world");
    expect(handle.plainText).toBe("hello world");
    handle.clear();
    expect(handle.plainText).toBe("");
  });

  it("fires onContentChange on programmatic mutation", () => {
    // The terminal's edit buffer emits content-change on ANY mutation and the
    // typeahead refreshes from it; a silent facade would leave suggestions
    // stale after history recall.
    const { notify, handle } = node();
    handle.setText("x");
    handle.insertText("y");
    handle.clear();
    expect(notify.content).toHaveBeenCalledTimes(3);
  });

  it("inserts text at the caret, replacing any selection", () => {
    const { element, handle } = node("abXYef");
    element.setSelectionRange(2, 4);
    handle.insertText("cd");
    expect(element.value).toBe("abcdef");
    expect(handle.cursorOffset).toBe(4);
  });

  it("gets and sets cursorOffset, clamped to the buffer", () => {
    const { element, notify, handle } = node("hello");
    handle.cursorOffset = 3;
    expect(element.selectionStart).toBe(3);
    expect(notify.cursor).toHaveBeenCalledTimes(1);
    handle.cursorOffset = 99;
    expect(element.selectionStart).toBe(5);
  });

  it("reports lineCount and logicalCursor from the caret", () => {
    // use-composer-keys recalls history on Up only when logicalCursor.row is
    // 0; a wrong row here turns history recall on (or off) mid-paragraph.
    const { element, handle } = node("one\ntwo\nthree");
    expect(handle.lineCount).toBe(3);
    element.setSelectionRange(5, 5); // inside "two"
    expect(handle.logicalCursor).toEqual({ row: 1, col: 1 });
    element.setSelectionRange(0, 0);
    expect(handle.logicalCursor).toEqual({ row: 0, col: 0 });
  });

  it("forwards focus/blur and reports focused from the component", () => {
    const { element, focusState, handle } = node();
    expect(handle.focused).toBe(false);
    focusState.value = true;
    expect(handle.focused).toBe(true);
    handle.focus();
    handle.blur();
    expect(element.focus).toHaveBeenCalled();
    expect(element.blur).toHaveBeenCalled();
  });

  it("requestRender is an explicit no-op", () => {
    // composer-context calls it after clear() because the TERMINAL batches
    // redraws; the DOM repaints itself, so there is nothing to flush — but the
    // call must exist and must not throw.
    const { handle } = node();
    expect(() => handle.requestRender()).not.toThrow();
  });

  it("reads defaults rather than throwing when the element is gone", () => {
    const handle = makeTextareaHandle(
      () => null,
      { content: vi.fn(), cursor: vi.fn() },
      () => false,
    );
    expect(handle.plainText).toBe("");
    expect(handle.cursorOffset).toBe(0);
    expect(handle.lineCount).toBe(1);
    expect(handle.logicalCursor).toEqual({ row: 0, col: 0 });
    expect(() => handle.setText("x")).not.toThrow();
    expect(() => handle.insertText("x")).not.toThrow();
  });
});

// ── Key bindings ─────────────────────────────────────────────────────────────

const COMPOSER_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
];

describe("matchKeyBinding", () => {
  const enter = { name: "return", ctrl: false, meta: false, shift: false };

  it("matches the bare key to the modifier-less binding", () => {
    expect(matchKeyBinding(COMPOSER_BINDINGS, enter)?.action).toBe("submit");
  });

  it("matches shift+return to the shift binding, not the bare one", () => {
    // Exact modifier comparison is what lets TEXTAREA_KEYBINDINGS carry both
    // entries: a looser match would submit on Shift+Enter.
    expect(matchKeyBinding(COMPOSER_BINDINGS, { ...enter, shift: true })?.action).toBe("newline");
  });

  it("does not invent bindings the prop did not declare", () => {
    // The modal editors pass only [{return → submit}]; Shift+Enter there must
    // match nothing (and so keep the browser's default newline).
    expect(matchKeyBinding([{ name: "return", action: "submit" }], { ...enter, shift: true })).toBeUndefined();
    expect(matchKeyBinding(COMPOSER_BINDINGS, { ...enter, ctrl: true })).toBeUndefined();
  });
});

// ── The component under jsdom ────────────────────────────────────────────────

function render(ui: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(ui));
  const element = host.querySelector("textarea")!;
  return {
    host,
    element,
    rerender: (next: ReactElement) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** Programmatic value change React can see (its value tracker needs the native setter). */
function typeInto(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(element, value);
  act(() => {
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

function keydown(element: HTMLTextAreaElement, init: KeyboardEventInit) {
  const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

function ta(props: Record<string, unknown> = {}): ReactElement {
  // createElement, not JSX: this file compiles through the vitest
  // `@opentui/react/jsx-runtime` stub, which returns plain `{type, props, key}`
  // objects react-dom cannot mount.
  return createElement(Textarea, props);
}

describe("Textarea component", () => {
  it("focuses the DOM element on mount when focused, and blurs when it flips false", () => {
    // `focused={!captureOpen}` is how modals take the keyboard away from the
    // composer; a facade that ignored it would keep inserting typed text
    // underneath an open modal.
    const { element, rerender, unmount } = render(ta({ focused: true }));
    expect(document.activeElement).toBe(element);
    rerender(ta({ focused: false }));
    expect(document.activeElement).not.toBe(element);
    unmount();
  });

  it("submits on Enter via the keyBindings prop, not on Shift+Enter", () => {
    const onSubmit = vi.fn();
    const { element, unmount } = render(ta({ focused: true, keyBindings: COMPOSER_BINDINGS, onSubmit }));

    const plain = keydown(element, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(plain.defaultPrevented).toBe(true);

    const shifted = keydown(element, { key: "Enter", shiftKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // "newline" is the browser's default action — the adapter must NOT
    // preventDefault it (jsdom performs no editing either way).
    expect(shifted.defaultPrevented).toBe(false);
    unmount();
  });

  it("leaves Enter alone when keyBindings declare nothing for it", () => {
    const onSubmit = vi.fn();
    const { element, unmount } = render(ta({ focused: true, onSubmit }));
    const event = keydown(element, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    unmount();
  });

  it("does not submit on a key a window-capture handler already claimed", () => {
    // The terminal gives global handlers first claim on every key (the
    // typeahead accepting Enter is the case that matters); the shim reproduces
    // that with window-capture listeners, and the element handler honours the
    // claim. Without this check Enter would submit the prompt while accepting
    // a suggestion.
    const onSubmit = vi.fn();
    const { element, unmount } = render(ta({ focused: true, keyBindings: COMPOSER_BINDINGS, onSubmit }));
    const event = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    event.preventDefault(); // as a capture-phase handler would have
    act(() => {
      element.dispatchEvent(event);
    });
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it("fires onContentChange and onCursorChange on user input", () => {
    const onContentChange = vi.fn();
    const onCursorChange = vi.fn();
    const { element, unmount } = render(ta({ focused: true, onContentChange, onCursorChange }));
    typeInto(element, "hi");
    expect(onContentChange).toHaveBeenCalledTimes(1);
    expect(onCursorChange).toHaveBeenCalled();
    const afterType = onCursorChange.mock.calls.length;
    keydown(element, { key: "ArrowLeft" });
    act(() => {
      element.dispatchEvent(new window.KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
    });
    // keydown may also fire `select` in jsdom, so the exact count is not the
    // contract — a caret move must notify at least once more.
    expect(onCursorChange.mock.calls.length).toBeGreaterThan(afterType);
    unmount();
  });

  it("renders the placeholder and its colour", () => {
    const { element, unmount } = render(ta({ placeholder: "Message Grok...", placeholderColor: "#8a8f9e" }));
    expect(element.placeholder).toBe("Message Grok...");
    // ::placeholder takes a real rule, not an inline style.
    const rule = [...document.head.querySelectorAll("style")].find((s) => s.textContent?.includes("::placeholder"));
    expect(rule?.textContent).toContain("#8a8f9e");
    unmount();
  });

  it("delivers paste as a PasteEvent whose bytes decode back to the clipboard text", () => {
    let received: { bytes: Uint8Array; defaultPrevented: boolean } | null = null;
    const { element, unmount } = render(
      ta({
        focused: true,
        onPaste: (event: { preventDefault(): void; bytes: Uint8Array }) => {
          received = event;
          event.preventDefault(); // as the paste-block path does
        },
      }),
    );
    const event = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => "line one\nline two" } });
    act(() => {
      element.dispatchEvent(event);
    });
    expect(received).not.toBeNull();
    expect(decodePasteBytes(received!.bytes)).toBe("line one\nline two");
    // preventDefault must reach the DOM event, or the raw text lands in the
    // buffer next to the paste-block token the handler just inserted.
    expect(event.defaultPrevented).toBe(true);
    unmount();
  });

  it("exposes the facade through the ref", () => {
    const ref: { current: TextareaHandle | null } = { current: null };
    const onContentChange = vi.fn();
    const { element, unmount } = render(
      ta({
        ref: (h: TextareaHandle | null) => {
          ref.current = h;
        },
        focused: true,
        onContentChange,
      }),
    );
    expect(ref.current?.focused).toBe(true);
    act(() => ref.current?.setText("draft"));
    expect(element.value).toBe("draft");
    expect(ref.current?.plainText).toBe("draft");
    expect(onContentChange).toHaveBeenCalled();
    act(() => {
      ref.current!.cursorOffset = 2;
    });
    expect(element.selectionStart).toBe(2);
    act(() => ref.current?.insertText("!"));
    expect(element.value).toBe("dr!aft");
    unmount();
  });
});

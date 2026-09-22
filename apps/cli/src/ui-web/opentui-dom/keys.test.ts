// DOM key events translated to the terminal's shape.
//
// The names and sequences asserted here are the ones the component tree
// actually branches on — `key.name === "return"` (38 call sites), `"up"` (33),
// `key.sequence === "\u001b"` and friends. A wrong name here does not throw;
// the handler simply never matches, and the key appears dead.

import { describe, expect, it } from "vitest";
import { WebKeyEvent } from "./keys.js";

function key(init: Partial<KeyboardEvent> & { key: string }): WebKeyEvent {
  const event = {
    type: "keydown",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    code: "",
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    prevented: false,
    stopped: false,
    ...init,
  } as unknown as KeyboardEvent;
  return new WebKeyEvent(event);
}

describe("key names", () => {
  it("uses the terminal's name for Enter, not the DOM's", () => {
    // "return", not "enter" — 38 call sites compare against "return".
    expect(key({ key: "Enter" }).name).toBe("return");
  });

  it("maps arrows, escape and editing keys", () => {
    expect(key({ key: "ArrowUp" }).name).toBe("up");
    expect(key({ key: "ArrowDown" }).name).toBe("down");
    expect(key({ key: "ArrowLeft" }).name).toBe("left");
    expect(key({ key: "ArrowRight" }).name).toBe("right");
    expect(key({ key: "Escape" }).name).toBe("escape");
    expect(key({ key: "Backspace" }).name).toBe("backspace");
    expect(key({ key: "Delete" }).name).toBe("delete");
    expect(key({ key: "Tab" }).name).toBe("tab");
    expect(key({ key: " " }).name).toBe("space");
    expect(key({ key: "Home" }).name).toBe("home");
    expect(key({ key: "End" }).name).toBe("end");
  });

  it("lowercases printable keys and carries shift separately", () => {
    // `key.name === "x"` must match whether or not shift is held; the tree
    // reads shift off the event, not off the case of the name.
    expect(key({ key: "x" }).name).toBe("x");
    expect(key({ key: "X", shiftKey: true }).name).toBe("x");
    expect(key({ key: "X", shiftKey: true }).shift).toBe(true);
    expect(key({ key: "]" }).name).toBe("]");
  });
});

describe("sequences", () => {
  it("gives escape the byte the input router compares against", () => {
    // src/ui/input compares key.sequence to "\u001b" directly.
    expect(key({ key: "Escape" }).sequence).toBe("\u001b");
    expect(key({ key: "Backspace" }).sequence).toBe("\u007f");
    expect(key({ key: "Enter" }).sequence).toBe("\r");
    expect(key({ key: "Tab" }).sequence).toBe("\t");
  });

  it("gives arrows their CSI sequences", () => {
    expect(key({ key: "ArrowUp" }).sequence).toBe("\u001b[A");
    expect(key({ key: "ArrowDown" }).sequence).toBe("\u001b[B");
  });

  it("passes a printable character through as its own sequence", () => {
    // `key.sequence === "/"` is how the slash menu opens.
    expect(key({ key: "/" }).sequence).toBe("/");
    expect(key({ key: "a" }).sequence).toBe("a");
  });
});

describe("modifiers and event type", () => {
  it("carries all four modifiers", () => {
    const k = key({ key: "c", ctrlKey: true, metaKey: true, shiftKey: true, altKey: true });
    expect([k.ctrl, k.meta, k.shift, k.option]).toEqual([true, true, true, true]);
  });

  it("distinguishes press, repeat and release", () => {
    expect(key({ key: "a" }).eventType).toBe("press");
    expect(key({ key: "a", repeat: true }).eventType).toBe("repeat");
    expect(key({ key: "a", type: "keyup" }).eventType).toBe("release");
  });
});

describe("preventDefault", () => {
  it("forwards to the DOM event", () => {
    // Without this the browser also acts: Tab moves focus out of the app and
    // space scrolls the page while a handler is trying to use them.
    let prevented = false;
    const event = {
      key: "Tab",
      type: "keydown",
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {},
    } as unknown as KeyboardEvent;

    const k = new WebKeyEvent(event);
    expect(k.defaultPrevented).toBe(false);
    k.preventDefault();
    expect(k.defaultPrevented).toBe(true);
    expect(prevented).toBe(true);
  });
});

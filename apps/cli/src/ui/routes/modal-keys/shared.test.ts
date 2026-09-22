import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { KeyEvent } from "@opentui/core";
import { describe, expect, it } from "vitest";
import { shouldStopModalKey } from "./shared";

const key = (name: string, sequence = name) => ({ name, sequence }) as unknown as KeyEvent;

describe("shouldStopModalKey", () => {
  it("stops every consumed key for list/menu modals (e.g. 'a' typed into the palette)", () => {
    expect(shouldStopModalKey(key("a"), false)).toBe(true);
    expect(shouldStopModalKey(key("down"), false)).toBe(true);
    expect(shouldStopModalKey(key("return", "\r"), false)).toBe(true);
  });

  it("lets printable/cursor keys reach the focused input of a text-entry modal", () => {
    expect(shouldStopModalKey(key("a"), true)).toBe(false);
    expect(shouldStopModalKey(key("left"), true)).toBe(false);
    expect(shouldStopModalKey(key("backspace"), true)).toBe(false);
  });

  it("still stops the keys a text-entry modal acts on", () => {
    expect(shouldStopModalKey(key("escape", "\u001b"), true)).toBe(true);
    expect(shouldStopModalKey(key("return", "\r"), true)).toBe(true);
    expect(shouldStopModalKey(key("tab", "\t"), true)).toBe(true);
  });

  it("is applied by the modal layer to every consumed key", () => {
    const source = readFileSync(fileURLToPath(new URL("../modal-layer.tsx", import.meta.url)), "utf8");
    expect(source).toContain("const consumed = simpleKeys(key) || listKeys(key) || complexKeys(key);");
    expect(source).toContain("if (shouldStopModalKey(key, textEntryOpen)) {");
    expect(source).toContain("key.stopPropagation?.();");
  });
});

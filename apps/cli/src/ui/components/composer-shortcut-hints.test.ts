import { describe, expect, it } from "vitest";
import { buildComposerShortcutHints, formatShortcutKeys, formatShortcutLabel } from "./composer-shortcut-hints";

const idle = {
  isProcessing: false,
  shellMode: false,
  queuedCount: 0,
  queueFocused: false,
  typeaheadVisible: false,
  runningAgentsCount: 0,
};

describe("buildComposerShortcutHints", () => {
  it("shows mode + commands when idle", () => {
    const hints = buildComposerShortcutHints(idle);
    expect(hints.map((h) => h.keys)).toEqual(["shift+tab", "ctrl+k"]);
  });

  it("shows mode + stop + queue while processing", () => {
    const hints = buildComposerShortcutHints({ ...idle, isProcessing: true });
    expect(hints.map((h) => `${h.keys}:${h.label}`)).toEqual(["shift+tab:mode", "ctrl+x:stop", "enter:queue"]);
  });

  it("adds send-now when one message is queued during a run", () => {
    const hints = buildComposerShortcutHints({ ...idle, isProcessing: true, queuedCount: 1 });
    expect(hints.some((h) => h.keys === "↑" && h.label === "send now")).toBe(true);
  });

  it("prioritizes typeahead navigation hints", () => {
    const hints = buildComposerShortcutHints({ ...idle, typeaheadVisible: true });
    expect(hints[0]?.label).toBe("accept");
  });

  it("shows shell mode run/exit", () => {
    const hints = buildComposerShortcutHints({ ...idle, shellMode: true });
    expect(hints).toEqual([
      { keys: "enter", label: "run" },
      { keys: "esc", label: "exit" },
    ]);
  });

  it("formats noisy footer shortcuts compactly", () => {
    expect(formatShortcutKeys("shift+tab", true)).toBe("⇧tab");
    expect(formatShortcutKeys("ctrl+x", true)).toBe("^x");
    expect(formatShortcutKeys("ctrl+k", true)).toBe("^k");
    expect(formatShortcutLabel("commands", true)).toBe("cmds");
    expect(formatShortcutLabel("send now", true)).toBe("send");
  });
});

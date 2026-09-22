import type { KeyBinding } from "@opentui/core";

/** Shared helper for centering modals with bottom bias */
export function bottomAlignedModalTop(height: number, panelHeight: number): number {
  return Math.max(2, Math.floor((height - panelHeight) / 2));
}

/** Common key bindings for the textarea inputs inside API key / Telegram modals */
export const TEXTAREA_KEYBINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
];

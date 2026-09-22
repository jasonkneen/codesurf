import type { KeyEvent } from "@opentui/core";

export function isEscapeKey(key: KeyEvent): boolean {
  return (
    key.name === "escape" ||
    key.code === "Escape" ||
    key.baseCode === 27 ||
    key.sequence === "\u001b" ||
    key.raw === "\u001b"
  );
}

/**
 * Whether a key a modal handler returned `true` for should stop propagating.
 * Handlers return true for every key while their modal is open (so the
 * composer and inline cards ignore it). Most of those keys are consumed and
 * must not reach any other handler — but text-entry modals (API key, tokens,
 * MCP / sub-agent editors, provider auth / setting edit) leave printable and
 * cursor keys for their focused input, so only the keys they act on
 * (esc, enter, tab) are stopped there.
 */
export function shouldStopModalKey(key: KeyEvent, textEntryOpen: boolean): boolean {
  if (!textEntryOpen) return true;
  return isEscapeKey(key) || key.name === "return" || key.name === "tab";
}

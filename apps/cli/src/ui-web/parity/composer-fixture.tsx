// Composer dogfood scene — not a parity capture.
//
// The widgets/markdown scenes are cell-diffed. A DOM <textarea> and OpenTUI's
// TextareaRenderable do not paint the same cells, so putting this in the
// harness would fail for the wrong reason. `?scene=composer` exists so the
// vite graph actually compiles the P2 adapter (the other scenes never import
// it) and so a human can look at the real composer in a browser.

import { getTheme } from "../../ui/themes/catalog.js";

export const COMPOSER_COLUMNS = 80;
export const COMPOSER_ROWS = 12;

const t = getTheme("dark");

export function ComposerScene() {
  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={2} gap={1}>
      <text fg={t.accent}>
        <b>{"codesurf — P2 composer (DOM textarea)"}</b>
      </text>
      <box borderStyle="single" borderColor={t.border} paddingLeft={1} paddingRight={1}>
        <textarea
          focused
          placeholder="Queue a follow-up… (ctrl+x to stop)"
          placeholderColor={t.textMuted}
          textColor={t.text}
          minHeight={3}
          maxHeight={8}
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "return", shift: true, action: "newline" },
          ]}
        />
      </box>
    </box>
  );
}

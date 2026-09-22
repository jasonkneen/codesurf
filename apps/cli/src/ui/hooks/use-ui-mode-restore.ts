import type { TextareaRenderable } from "@opentui/core";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import type { UiMode } from "../../utils/settings";

export function useUiModeRestore(
  uiMode: UiMode,
  setUiModeCtx: (mode: UiMode) => void,
  toggleUiModeCtx: () => void,
  inputRef: RefObject<TextareaRenderable | null>,
) {
  const pendingComposerRestoreRef = useRef<string>("");
  const previousUiModeRef = useRef<UiMode | null>(null);

  const setUiMode = useCallback(
    (next: UiMode) => {
      const draft = inputRef.current?.plainText ?? "";
      if (draft) pendingComposerRestoreRef.current = draft;
      setUiModeCtx(next);
    },
    [setUiModeCtx, inputRef.current?.plainText],
  );

  const toggleUiMode = useCallback(() => {
    const draft = inputRef.current?.plainText ?? "";
    if (draft) pendingComposerRestoreRef.current = draft;
    toggleUiModeCtx();
  }, [toggleUiModeCtx, inputRef.current?.plainText]);

  useEffect(() => {
    const previousUiMode = previousUiModeRef.current;
    previousUiModeRef.current = uiMode;
    const modeChanged = previousUiMode !== null && previousUiMode !== uiMode;
    if (!modeChanged && !pendingComposerRestoreRef.current) return;

    const tryRestore = (): boolean => {
      const ta = inputRef.current;
      if (!ta) return false;
      const draft = pendingComposerRestoreRef.current;
      ta.clear();
      if (draft) ta.insertText(draft);
      pendingComposerRestoreRef.current = "";
      ta.minHeight = 1;
      ta.maxHeight = 10;
      ta.height = "auto";
      ta.requestRender();
      return true;
    };
    if (tryRestore()) return;
    const id = setTimeout(() => tryRestore(), 0);
    return () => clearTimeout(id);
  }, [uiMode, inputRef.current]);

  return { setUiMode, toggleUiMode };
}

import type { CliRenderer, KeyEvent, PasteEvent } from "@opentui/core";
import { parseKeypress } from "@opentui/core";
import { useCallback, useEffect, useRef } from "react";

import type { InputKey } from "../../core/plugins/api";
import type { BtwState } from "../components/btw-overlay.js";
import type { InputRouterHandle } from "./types";

interface UseInputRouterOptions {
  renderer: CliRenderer;
  queueFocusId: string | null;
  setQueueFocusId: (id: string | null) => void;
  btwStateRef: React.RefObject<BtwState | null>;
  btwAbortRef: React.RefObject<AbortController | null>;
  setBtwState: (s: BtwState | null) => void;
  dispatchInputInterceptors: (event: InputKey) => boolean;

  // Current mode refs (needed for correct shortcut priority)
  shellModeRef: React.RefObject<boolean>;

  /** True when any modal/dialog/overlay is currently capturing keys
   *  (Slash menu, command palette, settings/agent/extensions modals,
   *  plan panel, typeahead, terminal input mode, etc.).
   *
   *  When set, the three raw Esc listeners below DO NOT call
   *  `dismissOnEscape` — they let the key flow through to OpenTUI's
   *  normal dispatch so the modal's own Esc handler (in `handleKey`)
   *  can dismiss it. Without this, an Esc during a long-running turn
   *  gets eaten by the abort path and never reaches the open modal,
   *  which is the "I can't Esc out of any dialogs" symptom. */
  isCaptureOpenRef?: React.RefObject<boolean>;

  // Lazy reader for the composer's current text content. Used to gate global
  // shortcuts that should only fire when the input is empty (e.g. `/` opens
  // the slash menu, but only when no characters have been typed yet — typing
  // `/foo/bar` mid-message should insert a literal slash, not pop a menu).
  getInputValue?: () => string;

  // Actions the router can trigger
  onOpenSlashMenu: (initialQuery?: string) => void;
  onOpenCommandPalette: (initialQuery?: string) => void;
  onGlobalPaste?: (event: PasteEvent) => boolean;
}

/**
 * useInputRouter
 *
 * Central owner of the four overlapping input systems in the TUI.
 * This is the "real InputRouter" the old god component comments were begging for.
 *
 * Responsibilities:
 * - Owns the three raw low-level Esc listeners (_internalKeyInput, prependInputHandler, stdin)
 * - Owns queue-focus vs interrupt priority for Esc
 * - Provides first-class methods to open global menus (/ and Ctrl+K) from anywhere,
 *   including during active agent turns (the main user request).
 * - Makes the priority contract explicit instead of scattered across 200 lines of useEffects.
 */
export function useInputRouter(options: UseInputRouterOptions): InputRouterHandle {
  const {
    renderer,
    queueFocusId,
    setQueueFocusId,
    btwStateRef,
    btwAbortRef,
    setBtwState,
    dispatchInputInterceptors,
    shellModeRef,
    isCaptureOpenRef,
    onOpenSlashMenu,
    onOpenCommandPalette,
    getInputValue,
    onGlobalPaste,
  } = options;

  const queueFocusIdRef = useRef<string | null>(queueFocusId);

  // Keep the ref in sync so raw listeners (which don't have React state) can read it
  useEffect(() => {
    queueFocusIdRef.current = queueFocusId;
  }, [queueFocusId]);

  // ──────────────────────────────────────────────────────────────────────────
  // dismissOnEscape (moved here from app.tsx)
  // ──────────────────────────────────────────────────────────────────────────
  // dismissOnEscape — Esc closes the transient overlays the router owns (the
  // `/btw` overlay). It NEVER aborts the run; that is Ctrl+X via the host.
  const dismissOnEscape = useCallback(
    (key?: KeyEvent) => {
      if (btwStateRef.current) {
        btwAbortRef.current?.abort();
        btwAbortRef.current = null;
        btwStateRef.current = null;
        setBtwState(null);
        key?.preventDefault?.();
        key?.stopPropagation?.();
        return true;
      }
      return false;
    },
    [btwStateRef, btwAbortRef, setBtwState],
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Three raw low-level Esc listeners (the heart of the old priority hack)
  // ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!onGlobalPaste) return;
    const onPaste = (event: PasteEvent) => {
      if (event.defaultPrevented) return;
      if (isCaptureOpenRef?.current) return;
      if (onGlobalPaste(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    renderer._internalKeyInput.onInternal("paste", onPaste);
    return () => renderer._internalKeyInput.offInternal("paste", onPaste);
  }, [onGlobalPaste, renderer, isCaptureOpenRef]);

  useEffect(() => {
    const onInternalKey = (key: KeyEvent) => {
      if (isEscapeKey(key)) {
        // Modal/dialog open → let Esc flow through to the modal's handler
        // in app.tsx's `handleKey`. Without this short-circuit, the raw
        // listener would abort the run and consume the key
        // before the modal ever saw it — the "I can't Esc out of any
        // dialogs while processing" symptom.
        if (isCaptureOpenRef?.current) return;
        if (queueFocusIdRef.current !== null) {
          setQueueFocusId(null);
          key.preventDefault?.();
          key.stopPropagation?.();
          return;
        }
        dismissOnEscape(key);
      }
    };
    renderer._internalKeyInput.onInternal("keypress", onInternalKey);
    return () => renderer._internalKeyInput.offInternal("keypress", onInternalKey);
  }, [dismissOnEscape, renderer, setQueueFocusId, isCaptureOpenRef]);

  useEffect(() => {
    const onRawInput = (sequence: string) => {
      const parsed = parseKeypress(sequence, { useKittyKeyboard: renderer.useKittyKeyboard });

      if (parsed) {
        const swallowed = dispatchInputInterceptors({
          name: parsed.name,
          sequence: parsed.sequence,
          ctrl: parsed.ctrl,
          meta: parsed.meta,
          shift: parsed.shift,
          option: parsed.option,
          super: parsed.super,
        });
        if (swallowed) return true;
      }

      if (parsed?.name === "escape" || sequence === "\u001b" || sequence === "\u001b\u001b") {
        // Modal open → return false so OpenTUI dispatch continues and the
        // modal's `handleKey` Esc branch can dismiss it.
        if (isCaptureOpenRef?.current) return false;
        if (queueFocusIdRef.current !== null) {
          setQueueFocusId(null);
          return true;
        }
        return dismissOnEscape();
      }
      return false;
    };

    renderer.prependInputHandler(onRawInput);
    return () => renderer.removeInputHandler(onRawInput);
  }, [dismissOnEscape, renderer, setQueueFocusId, dispatchInputInterceptors, isCaptureOpenRef]);

  useEffect(() => {
    const onStdinData = (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (data.length === 1 && data[0] === 27) {
        // Modal open → let the modal's handler (via useKeyboard) deal with Esc.
        if (isCaptureOpenRef?.current) return;
        if (queueFocusIdRef.current !== null) {
          setQueueFocusId(null);
          return;
        }
        dismissOnEscape();
      }
    };
    renderer.stdin.on("data", onStdinData);
    // Wrap in braces so the effect's destructor returns void rather than
    // ReadStream — TS rejects non-void destructors under strict React types.
    return () => {
      renderer.stdin.off("data", onStdinData);
    };
  }, [dismissOnEscape, renderer, setQueueFocusId, isCaptureOpenRef]);

  // ──────────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────────
  const openSlashMenu = useCallback(
    (initialQuery?: string) => {
      onOpenSlashMenu(initialQuery);
    },
    [onOpenSlashMenu],
  );

  const openCommandPalette = useCallback(
    (initialQuery?: string) => {
      onOpenCommandPalette(initialQuery);
    },
    [onOpenCommandPalette],
  );

  const isCaptureActive = useCallback((zone: "queue" | "terminal" | string) => {
    if (zone === "queue") return queueFocusIdRef.current !== null;
    // terminal / modal checks can be expanded later
    return false;
  }, []);

  const setModalOpen = useCallback((_modalId: string, _open: boolean) => {
    // Placeholder for future modal capture registration.
    // For now the old showXxxRef pattern in App still works.
  }, []);

  /**
   * handleKey - central decision point for global actions.
   * This is the beginning of pulling priority logic out of the giant handleKey in App.
   */
  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      if (isCaptureOpenRef?.current) return false;

      // Global shortcuts that should always be available (even during turns)
      //
      // `/` only opens the slash menu when the composer is empty. Typing `/`
      // mid-message (e.g. "src/foo/bar") must insert a literal slash, NOT pop
      // a menu. We read the composer value lazily via the optional
      // `getInputValue` accessor so the router doesn't need its own ref into
      // the TextareaRenderable.
      if (key.sequence === "/" && !shellModeRef.current) {
        const current = getInputValue?.() ?? "";
        if (current === "") {
          onOpenSlashMenu("");
          key.preventDefault?.();
          key.stopPropagation?.();
          return true;
        }
        // Composer has text — let the `/` flow through to the input.
      }

      if (key.name === "k" && key.ctrl && !key.shift) {
        onOpenCommandPalette("");
        key.preventDefault?.();
        key.stopPropagation?.();
        return true;
      }

      // Esc priority is already handled in the raw listeners.
      // We can expand this method over time to centralize more decisions.

      return false;
    },
    [onOpenSlashMenu, onOpenCommandPalette, shellModeRef, getInputValue, isCaptureOpenRef],
  );

  return {
    openSlashMenu,
    openCommandPalette,
    isCaptureActive,
    setModalOpen,
    handleKey,
  };
}

// Helper (duplicated from old code for now — can be cleaned later)
function isEscapeKey(key: KeyEvent): boolean {
  return key.name === "escape" || key.sequence === "\u001b" || key.sequence === "\u001b\u001b";
}

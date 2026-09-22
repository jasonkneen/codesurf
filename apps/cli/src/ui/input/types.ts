import type { KeyEvent } from "@opentui/core";

export type InputPriorityLayer =
  | "modal"
  | "terminal"
  | "typeahead"
  | "queue-focus"
  | "composer"
  | "global-shortcut"
  | "interrupt";

export interface InputRouterHandle {
  /** Open the slash menu from anywhere (including during active turns) */
  openSlashMenu: (initialQuery?: string) => void;

  /** Open the command palette from anywhere (including during active turns) */
  openCommandPalette: (initialQuery?: string) => void;

  /** Request interrupt of the current run (respects queue focus) */

  /** Check if a particular capture zone is active */
  isCaptureActive: (zone: "queue" | "terminal" | string) => boolean;

  /** Register that a modal is open so raw Esc listeners short-circuit correctly */
  setModalOpen: (modalId: string, open: boolean) => void;

  /**
   * Central entry point for key events.
   * Returns true if the router consumed the key (e.g. opened a global menu
   * or handled priority Esc). When it returns true, the caller should stop
   * further processing of that key.
   */
  handleKey: (key: KeyEvent) => boolean;
}

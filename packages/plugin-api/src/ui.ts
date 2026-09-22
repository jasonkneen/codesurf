// @codesurf/plugin-api/ui — optional rendering contracts.
//
// A separate entrypoint on purpose. These are the only contracts that need a
// renderer type, so a headless plugin — a provider, a tool, a command — imports
// `@codesurf/plugin-api` and never pulls React into its type graph. Only a
// plugin that actually draws something imports this.
//
// The import below is type-only: nothing here exists at runtime, and the
// package still ships no React dependency.

import type { ReactNode } from "react";
import type { InputKey, SettingSpec } from "./index";

/** Where a status indicator is drawn in the shell. */
export type StatusIndicatorPlacement = "input-footer" | "mode-line" | "mode-line-left";

/**
 * Keyboard access for a screen.
 *
 * `useKeyboard` is a React hook and must be called unconditionally during
 * render. It wraps the renderer's own hook so a screen never imports the
 * terminal renderer directly; the host's input interceptors still run first.
 */
export interface ScreenInput {
  useKeyboard(handler: (key: InputKey) => void): void;
}

/** What a screen is handed when the host renders it. */
export interface ScreenContext {
  /** Whatever the opener passed; the screen owns its own shape. */
  props: unknown;
  /** Dismiss this screen. */
  close: () => void;
  input: ScreenInput;
}

/** A full-surface screen contributed by a plugin. */
export interface ScreenSpec {
  id: string;
  label?: string;
  render: (ctx: ScreenContext) => ReactNode;
}

/** A small persistent readout in the shell chrome. */
export interface StatusIndicatorSpec {
  id: string;
  placement?: StatusIndicatorPlacement;
  /** Returning null draws nothing, which is how an indicator hides itself. */
  render: () => ReactNode | null;
}

/**
 * An indicator plus the command and settings that toggle it.
 *
 * The host registers all three together so a user-facing toggle cannot drift
 * out of sync with the indicator it controls.
 */
export interface ToggleableIndicatorSpec {
  id: string;
  placement?: StatusIndicatorPlacement;
  command: {
    name: string;
    description: string;
    toastShown?: string;
    toastHidden?: string;
  };
  settings: Array<Pick<SettingSpec, "key" | "title" | "description" | "section"> & { default?: boolean }>;
  render: StatusIndicatorSpec["render"];
  toastLabel?: string;
}

/**
 * Rendering registrations.
 *
 * Reached through `ctx.screens`, declared by this entrypoint's module
 * augmentation, so the property only exists for plugins that import it.
 */
export interface ScreensService {
  registerScreen(spec: ScreenSpec): () => void;
  registerStatusIndicator(spec: StatusIndicatorSpec): () => void;
  registerToggleableIndicator(spec: ToggleableIndicatorSpec): () => void;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    screens: ScreensService;
  }
}

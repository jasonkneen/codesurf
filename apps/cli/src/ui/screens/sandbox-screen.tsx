// Sandbox Picker as a plugin-owned screen.
//
// Registers `screen.sandbox` against the kernel's screen registry. The host's
// `<ScreenSlot>` renders this screen whenever the sandbox picker is open
// (driven by `showSandboxPicker` state in app.tsx, mirrored into the slot's
// `openScreens` map).
//
// Open/close state and keyboard handling stay in the host — only the JSX
// render lives here. `ScreenSpec` comes from the `/ui` entrypoint, the only
// place in the plugin contract where React types are allowed.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import type { ScreenContext } from "@codesurf/plugin-api/ui";
import { createElement } from "react";
import { SandboxPickerModal, type SandboxPickerProps } from "./sandbox-picker";

/** Stable id used by the host when firing `open-screen` for the sandbox picker. */
export const SANDBOX_SCREEN_ID = "screen.sandbox";

const manifest: PluginManifest = {
  id: "builtin.screens.sandbox",
  name: "Sandbox Picker Screen",
  version: "1.0.0",
  description: "Renders the Sandbox settings picker as a kernel-owned screen.",
  enabledByDefault: true,
  protected: true,
  hidden: true,
  capabilities: ["screens"],
};

export const sandboxScreenPlugin: CodesurfPlugin = {
  name: "codesurf-sandbox-screen",
  manifest,
  inject: ["screens"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.screens.registerScreen({
        id: SANDBOX_SCREEN_ID,
        label: "Sandbox settings",
        render: (screen: ScreenContext) => createElement(SandboxPickerModal, screen.props as SandboxPickerProps),
      }),
    );
  },
};

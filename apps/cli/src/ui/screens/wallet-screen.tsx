// Wallet Picker as a plugin-owned screen.
//
// Registers `screen.wallet` against the kernel's screen registry. The host's
// `<ScreenSlot>` renders this screen whenever the wallet picker is open
// (driven by `showWalletPicker` state in app.tsx, mirrored into the slot's
// `openScreens` map).
//
// Open/close state and keyboard handling stay in the host — only the JSX
// render lives here. `ScreenSpec` comes from the `/ui` entrypoint, the only
// place in the plugin contract where React types are allowed.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import type { ScreenContext } from "@codesurf/plugin-api/ui";
import { createElement } from "react";
import { WalletPickerModal, type WalletPickerProps } from "./wallet-picker";

/** Stable id used by the host when firing `open-screen` for the wallet picker. */
export const WALLET_SCREEN_ID = "screen.wallet";

const manifest: PluginManifest = {
  id: "builtin.screens.wallet",
  name: "Wallet Picker Screen",
  version: "1.0.0",
  description: "Renders the Wallet & Payments picker as a kernel-owned screen.",
  enabledByDefault: true,
  protected: true,
  hidden: true,
  capabilities: ["screens"],
};

export const walletScreenPlugin: CodesurfPlugin = {
  name: "codesurf-wallet-screen",
  manifest,
  inject: ["screens"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.screens.registerScreen({
        id: WALLET_SCREEN_ID,
        label: "Wallet & Payments",
        render: (screen: ScreenContext) => createElement(WalletPickerModal, screen.props as WalletPickerProps),
      }),
    );
  },
};

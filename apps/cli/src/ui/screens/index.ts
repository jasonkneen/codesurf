// UI-side builtin plugin bundle.
//
// Mirror of `src/core/plugins/builtin/index.ts` for plugins that own UI
// rendering. Kept on the UI side so the core kernel never imports React /
// JSX modules at runtime — preserving the ui→core layering.

import type { PluginModule } from "../../core/plugins";
import { createNativePluginModule } from "../../core/plugins/native/host";
import { sandboxScreenPlugin } from "./sandbox-screen";
import { walletScreenPlugin } from "./wallet-screen";

export async function loadBuiltinUiPlugins(): Promise<PluginModule[]> {
  return [createNativePluginModule(walletScreenPlugin), createNativePluginModule(sandboxScreenPlugin)];
}

export { SANDBOX_SCREEN_ID } from "./sandbox-screen";
export { WALLET_SCREEN_ID } from "./wallet-screen";

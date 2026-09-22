// Layout registry — registers the builtin session layouts and re-exports the
// lookup helpers. App imports `resolveLayoutId` / `getLayout` from here; new
// layouts are added by importing + registerLayout() below.

import { claudeCodeLayout } from "./claude-code";
import { opencodeLayout } from "./opencode";
import { getLayout, listLayouts, registerLayout, resolveLayoutId, setDefaultLayoutId } from "./types";

registerLayout(opencodeLayout);
registerLayout(claudeCodeLayout);
setDefaultLayoutId("opencode");

export type { LayoutContext, LayoutEntry } from "./types";
export { getLayout, listLayouts, registerLayout, resolveLayoutId, setDefaultLayoutId };

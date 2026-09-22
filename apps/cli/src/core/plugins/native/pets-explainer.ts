// Native Cordis plugin: the `/pets-arch` slash command.
//
// Converted from the V1 `activate(api)` builtin to an ordinary Cordis module
// (`name`, `manifest`, `inject`, `apply`). The command opens a read-only
// explainer of how the upstream Codex Rust TUI implements its `/pets` slash
// command, picker and ambient terminal-image rendering. Pure documentation
// surface — no agent I/O, no filesystem, no tools.
//
// The UI is rendered by the generic `doc-viewer` builtin; this plugin owns the
// content only. Host capabilities come solely from `@codesurf/plugin-api`; the
// registration is owned by `ctx.effect`, so unmounting the fiber removes the
// command.
//
// `../builtin/pets-arch-doc` is the one non-plugin-api import: it is inert
// content (a `DocViewerProps` literal), not a host contract, and it stays where
// V1 left it so the doc text is untouched by the conversion.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { PETS_ARCH_DOC } from "../builtin/pets-arch-doc";

const manifest: PluginManifest = {
  id: "builtin.commands.pets-explainer",
  name: "Codex /pets Architecture Explainer",
  version: "1.0.0",
  description:
    "Slash command `/pets-arch` opens a read-only explainer of how the upstream Codex Rust TUI implements `/pets`. Rendered via the generic `doc-viewer` builtin.",
  // A developer explainer, not a user feature: opt in from /plugins.
  enabledByDefault: false,
  protected: false,
  capabilities: ["commands"],
};

/**
 * The shared doc-viewer screen id.
 *
 * Resolved from the screen registry at invocation time rather than imported
 * from the sibling extension: the id is a stable public contract, kept here
 * only as a local lookup key. Carried over from V1 unchanged.
 */
const DOC_VIEWER_SCREEN_ID = "screen.doc-viewer";

export const petsExplainerPlugin: CodesurfPlugin = {
  name: "codesurf-pets-explainer",
  manifest,
  inject: ["contributions", "chat", "ui"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/pets-arch",
        description: "Open the Codex /pets architecture explainer (read-only overlay).",
        handler: () => {
          const docViewer = ctx.ui.screens.list().find((s) => s.id === DOC_VIEWER_SCREEN_ID);
          if (!docViewer) {
            ctx.chat.appendAssistant("Doc viewer is unavailable — enable the doc-viewer extension to view this.");
            return;
          }
          ctx.ui.action({
            type: "open-screen",
            id: docViewer.id,
            props: PETS_ARCH_DOC,
          });
        },
      }),
    );
  },
};

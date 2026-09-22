// Native Cordis plugin: the two footer chips.
//
// Merged from the former `builtin.context-bar` and `builtin.resource-counter`.
// Both are the same shape — N boolean toggles, one status indicator, one slash
// command that flips them together — which is exactly what
// `registerToggleableIndicator` composes, so the plugin declares intent and the
// host owns the expansion into settings + command + indicator.
//
// This was the last plugin to convert, and the only one that needed a change
// outside itself: its two components read the whole host services facade, which
// `@codesurf/plugin-api` deliberately does not expose. They now take narrow
// props — a `getSetting` reader and, for the meter, a `getStats` reader — and
// the render closures below supply them from `ctx`.
//
// Those closures wrap rather than pass: `ctx.settings.get` handed over as a
// bare reference loses its receiver, because Cordis services are classes. The
// same trap cost the knowledge plugin a runtime throw.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { createElement } from "react";
import { ContextBarIndicator } from "../builtin/footer-chrome/context-bar-indicator";
import { ResourceCounterIndicator } from "../builtin/footer-chrome/resource-counter-indicator";

const manifest: PluginManifest = {
  id: "builtin.footer-chrome",
  name: "Footer chrome",
  version: "1.0.0",
  description:
    "Footer chips: a context-window usage meter (right of the mode label) and a compact plugins / commands / tools counter (left).",
  enabledByDefault: true,
  protected: false,
  capabilities: ["commands", "settings", "status-indicators"],
};

export const footerChromePlugin: CodesurfPlugin = {
  name: "codesurf-footer-chrome",
  manifest,
  inject: ["screens", "settings", "contextMeter"],
  apply(ctx: PluginContext) {
    const getSetting = (key: string, fallback: boolean): boolean =>
      ctx.settings.get<boolean>(key, fallback) ?? fallback;

    // Right-hand context-window usage meter.
    ctx.effect(() =>
      ctx.screens.registerToggleableIndicator({
        id: "context-bar.usage",
        placement: "mode-line",
        toastLabel: "Context bar",
        command: {
          name: "/context-bar",
          description: "Toggle the footer context-window usage meter.",
        },
        settings: [
          {
            key: "contextBar.show.bar",
            title: "Context bar — show meter",
            description: "Display the dimmed block bar that fills as context is consumed.",
          },
          {
            key: "contextBar.show.percent",
            title: "Context bar — show percent",
            description: "Display the `NN%` usage percentage next to the meter.",
          },
          {
            key: "contextBar.show.tokens",
            title: "Context bar — show token count",
            description: "Display the `NNk / NNNk` token count next to the meter.",
          },
        ],
        render: () =>
          createElement(ContextBarIndicator, {
            getSetting,
            getStats: () => ctx.contextMeter.getStats(),
          }),
      }),
    );

    // Left-hand plugins / commands / tools counter.
    ctx.effect(() =>
      ctx.screens.registerToggleableIndicator({
        id: "resource-counter.counts",
        placement: "mode-line-left",
        toastLabel: "Resource counter",
        command: {
          name: "/resource-counter",
          description: "Toggle the footer resource counter (plugins / commands / tools counts).",
        },
        settings: [
          {
            key: "resourceCounter.show.extensions",
            title: "Resource counter — show plugins count",
            description: "Display `N/N ext` (enabled / total plugins) on the footer.",
          },
          {
            key: "resourceCounter.show.commands",
            title: "Resource counter — show commands count",
            description: "Display `N cmd` (enabled-plugin slash commands) on the footer.",
          },
          {
            key: "resourceCounter.show.tools",
            title: "Resource counter — show tools count",
            description: "Display `N tool` (enabled-plugin tools) on the footer.",
          },
        ],
        render: () => createElement(ResourceCounterIndicator, { getSetting }),
      }),
    );
  },
};

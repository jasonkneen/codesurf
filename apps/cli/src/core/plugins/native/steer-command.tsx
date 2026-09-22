// Native Cordis plugin: steering questions.
//
// Converted from the V1 entry with the same screen id, command name, argsHint
// and description, so existing openers and muscle memory are unaffected. The
// screen and the command are separate effects, each released on disposal.

import type { CodesurfPlugin, PluginContext, PluginManifest, SettingsService } from "@codesurf/plugin-api";
import type { ScreenContext } from "@codesurf/plugin-api/ui";
import { useTerminalDimensions } from "@opentui/react";
import { createElement, useMemo } from "react";
import { makeExampleQuestionnaireTabs, QuestionnaireTabs } from "../../../ui/ai-output/questionnaire-tabs";
import { optionIndexForValue, STEER_DIMENSIONS, steerSettingKey } from "../../persistence/steering";
import { ScreenOverlay } from "../builtin/screen-overlay";
import { useHostTheme } from "../host-theme";

export const STEER_SCREEN_ID = "screen.steer";

function SteerScreen({ ctx, settings }: { ctx: ScreenContext; settings: SettingsService }) {
  const { width, height } = useTerminalDimensions();
  const t = useHostTheme();

  ctx.input.useKeyboard((key) => {
    if (key.name === "escape" || key.sequence === "") ctx.close();
  });

  // Seed each tab's selection from the persisted setting (falls back to the
  // questionnaire's own recommended default when nothing is stored). Built once
  // per open so reopening reflects the latest saved choices.
  const tabs = useMemo(() => {
    const base = makeExampleQuestionnaireTabs();
    for (const tab of base) {
      const persisted = settings.get<string>(steerSettingKey(tab.id));
      const labels = tab.question.options.map((option) => option.label);
      const index = optionIndexForValue(labels, typeof persisted === "string" ? persisted : undefined);
      if (index >= 0) tab.question.selectedIndex = index;
    }
    return base;
  }, [settings]);

  // Commit every answer at once, then close. Nothing is written before this —
  // closing with esc discards the pending selections.
  const handleSubmit = (answers: Record<string, string>) => {
    for (const [tabId, label] of Object.entries(answers)) {
      settings.set(steerSettingKey(tabId), label);
    }
    ctx.close();
  };

  const panelWidth = Math.min(96, width - 4);
  const panelHeight = Math.min(28, height - 4);

  return (
    <ScreenOverlay panelWidth={panelWidth} panelHeight={panelHeight}>
      <box flexShrink={0} flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <text fg={t.primary}>
          <b>{"steering questions"}</b>
        </text>
        <text fg={t.textMuted}>{"esc cancels"}</text>
      </box>
      <QuestionnaireTabs t={t} tabs={tabs} onSubmit={handleSubmit} />
    </ScreenOverlay>
  );
}

const manifest: PluginManifest = {
  id: "builtin.commands.steer",
  name: "Steering Questions",
  version: "1.0.0",
  description:
    "Slash command `/steer` opens a tabbed panel to set scope / risk / verification preferences. " +
    "Selections persist via services.settings and are projected into the agent's system prompt.",
  enabledByDefault: true,
  protected: false,
  capabilities: ["commands", "screens", "settings"],
};

export const steerCommandPlugin: CodesurfPlugin = {
  name: "codesurf-steer-command",
  manifest,
  inject: ["contributions", "screens", "chat", "workspace", "ui", "settings"],
  apply(ctx: PluginContext) {
    // Register one select-setting per steering dimension so the choices appear
    // in the settings surface and carry a recommended default. Options/defaults
    // are derived from the questionnaire to keep a single source of truth.
    const exampleTabs = makeExampleQuestionnaireTabs();
    for (const dim of STEER_DIMENSIONS) {
      const tab = exampleTabs.find((item) => item.id === dim.id);
      if (!tab) continue;
      const options = tab.question.options.map((option) => ({ value: option.label, label: option.label }));
      const recommended =
        tab.question.options.find((option) => option.recommended)?.label ?? tab.question.options[0]?.label ?? "";
      ctx.effect(() =>
        ctx.contributions.registerSetting({
          key: dim.settingKey,
          title: `Steering — ${dim.promptLabel}`,
          description: tab.question.prompt,
          type: "select",
          default: recommended,
          section: "Steering",
          options,
        }),
      );
    }

    ctx.effect(() =>
      ctx.screens.registerScreen({
        id: STEER_SCREEN_ID,
        label: "Steering Questions",
        render: (screenCtx: ScreenContext) => createElement(SteerScreen, { ctx: screenCtx, settings: ctx.settings }),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/steer",
        description: "Open the steering-questions panel to set scope / risk / verification preferences.",
        handler: () => {
          ctx.ui.action({ type: "open-screen", id: STEER_SCREEN_ID });
        },
      }),
    );
  },
};

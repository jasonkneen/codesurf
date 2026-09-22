// Skills listing builtin extension.
//
// Owns the `/skills` slash command. Opens an interactive, selectable screen
// (`screen.skills`) listing every discovered project + global Agent Skill.
// From the list the user can:
//   - enable/disable a skill globally   (persisted via services.settings →
//     extensions.json `skills.disabled`)
//   - enable/disable a skill for the session only (in-memory, process-lifetime)
//   - view the skill's SKILL.md details
//
// Disabled skills are filtered out of the model prompt by `filterEnabledSkills`
// at injection time (see src/agent/agent.ts + claude-skills-provider.ts).
//
// `/skills optimize` keeps its read-only behaviour: it mines few-shot overlays
// from rated turns and writes the result straight into the transcript.

import { readFileSync } from "node:fs";
import type { CodesurfPlugin, PluginContext, PluginManifest, SettingsService } from "@codesurf/plugin-api";
import type { ScreenContext } from "@codesurf/plugin-api/ui";
import { useTerminalDimensions } from "@opentui/react";
import { createElement, useMemo, useState } from "react";
import { optimizeSkillsFromTraces } from "../../../agent/learning/skill-optimizer";
import { type DiscoveredSkill, discoverSkills } from "../../../utils/skills";
import {
  SKILLS_DISABLED_SETTING_KEY,
  setSessionSkillDisabled,
  skillEnablement,
} from "../../persistence/skills-enablement";
import { ScreenOverlay } from "../builtin/screen-overlay";
import { useHostTheme } from "../host-theme";

export const SKILLS_SCREEN_ID = "screen.skills";

interface SkillsScreenProps {
  /** Optional case-insensitive substring filter applied to the initial list. */
  filter?: string;
}

/** Read the global-disabled set as an array and persist a toggle for `name`. */
function persistGlobalToggle(settings: SettingsService, name: string, disabled: boolean): void {
  const current = settings.get<string[]>(SKILLS_DISABLED_SETTING_KEY, []) ?? [];
  const next = new Set(current.filter((v): v is string => typeof v === "string"));
  if (disabled) next.add(name);
  else next.delete(name);
  settings.set(SKILLS_DISABLED_SETTING_KEY, [...next].sort());
}

function stateBadge(state: ReturnType<typeof skillEnablement>): { label: string; tone: "on" | "global" | "session" } {
  switch (state) {
    case "disabled-global":
      return { label: "off · global", tone: "global" };
    case "disabled-session":
      return { label: "off · session", tone: "session" };
    default:
      return { label: "on", tone: "on" };
  }
}

function readSkillBody(skill: DiscoveredSkill): string[] {
  try {
    return readFileSync(skill.skillMdPath, "utf8").split("\n");
  } catch (err) {
    return [`Couldn't read SKILL.md: ${err instanceof Error ? err.message : String(err)}`];
  }
}

function SkillsScreen({ ctx, settings, cwd }: { ctx: ScreenContext; settings: SettingsService; cwd: () => string }) {
  const { width, height } = useTerminalDimensions();
  const t = useHostTheme();
  const props = (ctx.props ?? null) as SkillsScreenProps | null;
  const filter = (props?.filter ?? "").trim().toLowerCase();

  const skills = useMemo(() => {
    const all = discoverSkills(cwd());
    if (!filter) return all;
    return all.filter((s) => s.name.toLowerCase().includes(filter) || s.description.toLowerCase().includes(filter));
  }, [cwd, filter]);

  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<"list" | "detail">("list");
  const [scroll, setScroll] = useState(0);
  // Enablement lives outside React (module + disk); bump to force a re-read.
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  const current = skills[selected];

  ctx.input.useKeyboard((key) => {
    if (mode === "detail") {
      if (key.name === "escape" || key.name === "return" || key.sequence === "v") {
        setMode("list");
        return;
      }
      if (key.name === "down" || key.sequence === "j") setScroll((s) => s + 1);
      else if (key.name === "up" || key.sequence === "k") setScroll((s) => Math.max(0, s - 1));
      return;
    }
    if (key.name === "escape" || key.sequence === "") {
      ctx.close();
      return;
    }
    if (skills.length === 0) return;
    if (key.name === "down" || key.sequence === "j") {
      setSelected((i) => Math.min(skills.length - 1, i + 1));
    } else if (key.name === "up" || key.sequence === "k") {
      setSelected((i) => Math.max(0, i - 1));
    } else if (key.name === "return" || key.sequence === "v") {
      setScroll(0);
      setMode("detail");
    } else if (key.sequence === "g" && current) {
      const nowDisabled = skillEnablement(current.name) !== "disabled-global";
      persistGlobalToggle(settings, current.name, nowDisabled);
      bump();
    } else if (key.sequence === "s" && current) {
      const nowDisabled = skillEnablement(current.name) !== "disabled-session";
      // Session toggle only meaningful when not globally disabled.
      setSessionSkillDisabled(current.name, nowDisabled);
      bump();
    }
  });

  const panelWidth = Math.min(110, width - 4);
  const panelHeight = Math.min(34, height - 4);

  if (mode === "detail" && current) {
    const bodyHeight = panelHeight - 6;
    const bodyWidth = Math.max(20, panelWidth - 6);
    const body = readSkillBody(current);
    const maxScroll = Math.max(0, body.length - bodyHeight);
    const start = Math.min(scroll, maxScroll);
    const visible = body.slice(start, start + bodyHeight);
    return (
      <ScreenOverlay panelWidth={panelWidth} panelHeight={panelHeight}>
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <text fg={t.primary} wrapMode="none">
            <b>{current.name}</b>
            <span style={{ fg: t.textMuted }}>{`  (${current.scope})`}</span>
          </text>
          <text fg={t.textMuted}>{"j/k scroll · esc back"}</text>
        </box>
        <box flexDirection="column" flexGrow={1}>
          {visible.map((line, idx) => {
            // Pad to full content width + opaque bg so the transcript behind the
            // overlay can't bleed through short lines / trailing cells.
            const padded =
              line.length >= bodyWidth ? line.slice(0, bodyWidth) : line + " ".repeat(bodyWidth - line.length);
            return (
              <text
                // biome-ignore lint/suspicious/noArrayIndexKey: text lines have no stable id; composite key includes scroll offset
                key={`${start}-${idx}`}
                bg={t.backgroundPanel}
                fg={line.startsWith("  ") ? t.accent : t.text}
                wrapMode="none"
              >
                {padded}
              </text>
            );
          })}
        </box>
        <box flexShrink={0} marginTop={1}>
          <text
            fg={t.textMuted}
          >{`line ${start + 1}-${Math.min(start + bodyHeight, body.length)} / ${body.length}`}</text>
        </box>
      </ScreenOverlay>
    );
  }

  const nameWidth = skills.length > 0 ? Math.min(28, Math.max(...skills.map((s) => s.name.length))) : 12;
  const pad = (s: string, w: number): string => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length));

  // Window the list so the selected row stays visible (the catalog can be
  // dozens of skills — far more than the panel's row budget).
  const listHeight = Math.max(1, panelHeight - 4);
  const windowStart = Math.max(
    0,
    Math.min(selected - Math.floor(listHeight / 2), Math.max(0, skills.length - listHeight)),
  );
  const visibleSkills = skills
    .slice(windowStart, windowStart + listHeight)
    .map((skill, i) => ({ skill, idx: windowStart + i }));

  return (
    <ScreenOverlay panelWidth={panelWidth} panelHeight={panelHeight}>
      <box flexShrink={0} flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <text fg={t.primary} wrapMode="none">
          <b>{"agent skills"}</b>
          <span style={{ fg: t.textMuted }}>{`  ${skills.length}${filter ? ` (filter: "${filter}")` : ""}`}</span>
        </text>
        <text fg={t.textMuted}>{"enter details · g global · s session · esc"}</text>
      </box>
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        {skills.length === 0 ? (
          <text fg={t.textMuted}>{"No Agent Skills found."}</text>
        ) : (
          visibleSkills.map(({ skill: s, idx }) => {
            const badge = stateBadge(skillEnablement(s.name));
            const tone = badge.tone === "on" ? t.diffAddedFg : badge.tone === "global" ? t.diffRemovedFg : t.accent;
            const isSel = idx === selected;
            const contentWidth = Math.max(20, panelWidth - 6);
            const descWidth = Math.max(20, contentWidth - nameWidth - 19);
            const desc = s.description.replace(/\s+/g, " ").trim();
            const descClipped = desc.length > descWidth ? `${desc.slice(0, descWidth - 1)}…` : desc;
            // One <text> per row with span segments: a single line lays out
            // sequentially so the columns can never overlap (sibling <text>
            // elements in a flex row mis-measure and collide). pad() keeps the
            // columns aligned. CRITICAL: the row text carries an opaque `bg` and
            // every column is padded to a fixed width so ALL cells (the spaces
            // between columns and the tail after the description) are painted —
            // otherwise transparent space cells let the transcript behind the
            // overlay bleed through ("Use when" → "Useuwhen…").
            const rowBg = isSel ? t.backgroundElement : t.backgroundPanel;
            return (
              <box key={s.skillMdPath} flexDirection="row" overflow="hidden">
                <text bg={rowBg} wrapMode="none">
                  <span
                    style={{ fg: isSel ? t.accent : t.text }}
                  >{`${isSel ? "> " : "  "}${pad(s.name, nameWidth)}`}</span>
                  <span style={{ fg: tone }}>{`  ${pad(badge.label, 13)}`}</span>
                  <span style={{ fg: t.textMuted }}>{`  ${pad(descClipped, descWidth)}`}</span>
                </text>
              </box>
            );
          })
        )}
      </box>
    </ScreenOverlay>
  );
}

function renderOptimize(cwd: string): string {
  const results = optimizeSkillsFromTraces({ cwd });
  if (results.length === 0) {
    return "No skill overlays written. Overlays are mined from high-feedback turns that used a skill (read its SKILL.md). Rate turns with /feedback, then try again.";
  }
  const lines = results.map((r) => `- ${r.skill}: ${r.examples} example(s) from ${r.sampleCount} trace(s)`).join("\n");
  return `Updated skill overlays (injected as <learned_examples> next session):\n${lines}`;
}

const manifest: PluginManifest = {
  id: "builtin.commands.skills",
  name: "Skills Listing",
  version: "2.0.0",
  description:
    "Slash command `/skills` opens a selectable list of discovered project + global skills with enable/disable (global or session) and a SKILL.md detail view. `/reload-skills` re-scans disk and reconnects the active model session so catalogue changes take effect immediately.",
  enabledByDefault: true,
  protected: false,
  capabilities: ["commands", "screens", "settings"],
};

export const skillsListingPlugin: CodesurfPlugin = {
  name: "codesurf-skills-listing",
  manifest,
  inject: ["contributions", "screens", "chat", "settings", "ui"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.screens.registerScreen({
        id: SKILLS_SCREEN_ID,
        label: "Agent Skills",
        render: (screenCtx: ScreenContext) =>
          createElement(SkillsScreen, { ctx: screenCtx, settings: ctx.settings, cwd: () => ctx.workspace.cwd() }),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/skills",
        description:
          "Open the skills list (enable/disable globally or for the session, view details). `/skills optimize` mines few-shot overlays from rated turns.",
        argsHint: "[filter] | optimize",
        handler: ({ args }) => {
          const trimmed = args.trim();
          if (trimmed === "optimize" || trimmed.startsWith("optimize ")) {
            ctx.chat.appendAssistant(renderOptimize(ctx.workspace.cwd()));
            return;
          }
          ctx.ui.action({
            type: "open-screen",
            id: SKILLS_SCREEN_ID,
            props: { filter: trimmed } satisfies SkillsScreenProps,
          });
        },
      }),
    );

    ctx.effect(async () =>
      ctx.contributions.registerCommand({
        name: "/reload-skills",
        description:
          "Re-scan Agent Skills from disk and reconnect the active model session, so newly installed/removed skills take effect on your next message without restarting the app.",
        aliases: ["/reload-skill"],
        handler: async () => {
          const skills = discoverSkills(ctx.workspace.cwd());
          const result = await ctx.session.reconnect();
          ctx.chat.appendAssistant(`Re-discovered ${skills.length} skill(s) on disk.\n${result.message}`);
        },
      }),
    );
  },
};

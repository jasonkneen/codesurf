// Native Cordis plugin: the generic document viewer.
//
// A two-pane read-only overlay — table of contents on the left, body on the
// right, j/k to navigate, esc to close. It carries no content of its own; other
// plugins open it with
//
//   ctx.ui.action({ type: "open-screen", id: DOC_VIEWER_SCREEN_ID, props })
//
// Converted from the V1 entry with the same screen id, so every existing opener
// keeps working unchanged.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import type { ScreenContext } from "@codesurf/plugin-api/ui";
import { useTerminalDimensions } from "@opentui/react";
import { createElement, useEffect, useState } from "react";
import { ScreenOverlay } from "../builtin/screen-overlay";
import { useHostTheme } from "../host-theme";

export const DOC_VIEWER_SCREEN_ID = "screen.doc-viewer";

/** A single navigable section in a document. */
export interface DocSection {
  /** Stable id used as the React key and for deep-linking. */
  id: string;
  /** Title shown in the TOC and as the body heading. */
  title: string;
  /**
   * Body content as a list of plain-text lines. Rendered with
   * `wrapMode="none"` so callers control wrapping — keep lines short or
   * pre-wrap them. Lines starting with two spaces are accent-coloured to
   * suggest code/indented blocks.
   */
  body: string[];
}

/** Props passed via `services.ui.action({ type: "open-screen", props })`. */
export interface DocViewerProps {
  /** Document title shown in the panel header. */
  title: string;
  /** Optional footer hint string. Defaults to standard keybindings. */
  footerHint?: string;
  /** Sections to render in declaration order. */
  sections: DocSection[];
  /** Optional starting section id; falls back to the first section. */
  initialSectionId?: string;
}

function isDocViewerProps(value: unknown): value is DocViewerProps {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.title === "string" &&
    Array.isArray(v.sections) &&
    v.sections.every(
      (s) =>
        s != null &&
        typeof s === "object" &&
        typeof (s as Record<string, unknown>).id === "string" &&
        typeof (s as Record<string, unknown>).title === "string" &&
        Array.isArray((s as Record<string, unknown>).body),
    )
  );
}

function DocViewerScreen({ ctx }: { ctx: ScreenContext }) {
  const { width, height } = useTerminalDimensions();
  const t = useHostTheme();

  const props = isDocViewerProps(ctx.props) ? ctx.props : null;
  const sections = props?.sections ?? [];
  const initialIndex = (() => {
    if (!props?.initialSectionId) return 0;
    const idx = sections.findIndex((s) => s.id === props.initialSectionId);
    return idx >= 0 ? idx : 0;
  })();
  const [selected, setSelected] = useState(initialIndex);

  // Reset selection when the doc changes (host re-opens with new props).
  useEffect(() => {
    setSelected(initialIndex);
    // initialIndex captures both the doc identity (via sections ref) and the
    // requested initial section, so it's the right dependency here.
  }, [initialIndex]);

  ctx.input.useKeyboard((key) => {
    if (key.name === "escape" || key.sequence === "") {
      ctx.close();
      return;
    }
    if (sections.length === 0) return;
    if (key.name === "down" || key.sequence === "j") {
      setSelected((i) => Math.min(sections.length - 1, i + 1));
      return;
    }
    if (key.name === "up" || key.sequence === "k") {
      setSelected((i) => Math.max(0, i - 1));
      return;
    }
    if (key.name === "home" || key.sequence === "g") {
      setSelected(0);
      return;
    }
    if (key.name === "end" || key.sequence === "G") {
      setSelected(sections.length - 1);
    }
  });

  if (!props || sections.length === 0) return null;

  const panelWidth = Math.min(110, width - 4);
  const panelHeight = Math.min(36, height - 4);
  const tocWidth = 32;
  const bodyHeight = panelHeight - 6;
  const section = sections[selected]!;
  const visibleBody = section.body.slice(0, Math.max(1, bodyHeight - 2));
  const footerHint = props.footerHint ?? "j/k move · g/G top/end · esc close";

  return (
    <ScreenOverlay panelWidth={panelWidth} panelHeight={panelHeight}>
      <box flexShrink={0} flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <text fg={t.primary}>
          <b>{props.title}</b>
        </text>
        <text fg={t.textMuted}>{footerHint}</text>
      </box>
      <box flexDirection="row" flexGrow={1}>
        <box width={tocWidth} flexDirection="column" paddingRight={1}>
          {sections.map((s, idx) => (
            <text key={s.id} fg={idx === selected ? t.accent : t.text} wrapMode="none">
              {idx === selected ? "> " : "  "}
              {s.title}
            </text>
          ))}
        </box>
        <box flexDirection="column" flexShrink={0}>
          {Array.from({ length: Math.max(1, bodyHeight) }).map((_, idx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: separator bars are positional with no stable id
            <text key={`sep-${idx}`} fg={t.textMuted} wrapMode="none">
              {"│"}
            </text>
          ))}
        </box>
        <box flexDirection="column" paddingLeft={2} flexGrow={1}>
          <text fg={t.primary} wrapMode="none">
            <b>{section.title}</b>
          </text>
          <box flexDirection="column" marginTop={1}>
            {visibleBody.map((line, idx) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: text lines have no stable id; composite key includes section.id
              <text key={`${section.id}-${idx}`} fg={line.startsWith("  ") ? t.accent : t.text} wrapMode="none">
                {line.length === 0 ? " " : line}
              </text>
            ))}
          </box>
        </box>
      </box>
      <box flexShrink={0} marginTop={1}>
        <text fg={t.textMuted}>{`section ${selected + 1} / ${sections.length}`}</text>
      </box>
    </ScreenOverlay>
  );
}

const manifest: PluginManifest = {
  id: "builtin.ui.doc-viewer",
  name: "Doc Viewer",
  version: "1.0.0",
  description:
    "Generic two-pane overlay for displaying read-only structured documents (wikis, learnings, research, architecture explainers). Opened by other plugins via `services.ui.action({ type: 'open-screen', id: 'screen.doc-viewer', props })`.",
  enabledByDefault: true,
  protected: false,
  capabilities: ["screens"],
};

export const docViewerPlugin: CodesurfPlugin = {
  name: "codesurf-doc-viewer",
  manifest,
  inject: ["screens"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.screens.registerScreen({
        id: DOC_VIEWER_SCREEN_ID,
        label: "Doc Viewer",
        render: (screenCtx: ScreenContext) => createElement(DocViewerScreen, { ctx: screenCtx }),
      }),
    );
  },
};

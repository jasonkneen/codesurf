// Native Cordis plugin: text editor.
//
// Converted from the V1 entry with the same screen id, command name, argsHint
// and description, so existing openers and muscle memory are unaffected. The
// screen and the command are separate effects, each released on disposal.

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import type { ScreenContext } from "@codesurf/plugin-api/ui";
import { useTerminalDimensions } from "@opentui/react";
import { createElement, useState } from "react";
import { TextEditor } from "../../../ui/ai-output/text-editor";
import { ScreenOverlay } from "../builtin/screen-overlay";
import { useHostTheme } from "../host-theme";

export const EDITOR_SCREEN_ID = "screen.editor";

interface EditorScreenProps {
  cwd: string;
  path: string | null;
  initialContent: string;
}

function EditorScreen({ ctx }: { ctx: ScreenContext }) {
  const { width, height } = useTerminalDimensions();
  const props = (ctx.props ?? { cwd: process.cwd(), path: null, initialContent: "" }) as EditorScreenProps;
  const t = useHostTheme();
  const [status, setStatus] = useState<string | null>(null);

  ctx.input.useKeyboard((key) => {
    if (key.name === "escape" || key.sequence === "") ctx.close();
  });

  const absolutePath = props.path ? (isAbsolute(props.path) ? props.path : resolvePath(props.cwd, props.path)) : null;

  const handleSave = (content: string): boolean | undefined => {
    if (!absolutePath) {
      setStatus("no path — scratch buffer not persisted");
      return true;
    }
    try {
      writeFileSync(absolutePath, content, "utf8");
      setStatus(`saved → ${props.path}`);
      return true;
    } catch (err) {
      setStatus(`save failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  const panelWidth = Math.min(100, width - 4);
  const panelHeight = Math.min(28, height - 4);
  const editorHeight = Math.max(8, panelHeight - 10);

  return (
    <ScreenOverlay panelWidth={panelWidth} panelHeight={panelHeight}>
      <box flexShrink={0} flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <text fg={t.primary}>
          <b>{props.path ? `edit ${props.path}` : "scratch buffer"}</b>
        </text>
        <text fg={t.textMuted}>{"esc"}</text>
      </box>
      <TextEditor
        t={t}
        title={props.path ?? "scratch"}
        path={props.path ?? undefined}
        initialContent={props.initialContent}
        editorHeight={editorHeight}
        compact
        onSave={handleSave}
      />
      {status ? (
        <box marginTop={1}>
          <text fg={t.textMuted}>{status}</text>
        </box>
      ) : null}
    </ScreenOverlay>
  );
}

const manifest: PluginManifest = {
  id: "builtin.commands.editor",
  name: "Text Editor",
  version: "1.0.0",
  description: "Slash command `/edit [path]` opens an inline text editor for the optional file path.",
  enabledByDefault: true,
  protected: false,
  capabilities: ["commands", "screens"],
};

export const editorCommandPlugin: CodesurfPlugin = {
  name: "codesurf-editor-command",
  manifest,
  inject: ["contributions", "screens", "chat", "workspace", "ui", "settings"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.screens.registerScreen({
        id: EDITOR_SCREEN_ID,
        label: "Text Editor",
        render: (screenCtx: ScreenContext) => createElement(EditorScreen, { ctx: screenCtx }),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/edit",
        description: "Open the text editor. Pass a path to load a file; no path opens a scratch buffer.",
        argsHint: "[path]",
        handler: ({ args }) => {
          const trimmed = args.trim();
          const cwd = ctx.workspace.cwd();
          let path: string | null = null;
          let initialContent = "";

          if (trimmed.length > 0) {
            path = trimmed;
            const absolute = isAbsolute(trimmed) ? trimmed : resolvePath(cwd, trimmed);
            try {
              initialContent = readFileSync(absolute, "utf8");
            } catch (err) {
              ctx.chat.appendAssistant(`Couldn't read ${trimmed}: ${err instanceof Error ? err.message : String(err)}`);
              return;
            }
          }

          ctx.ui.action({
            type: "open-screen",
            id: EDITOR_SCREEN_ID,
            props: { cwd, path, initialContent } satisfies EditorScreenProps,
          });
        },
      }),
    );
  },
};

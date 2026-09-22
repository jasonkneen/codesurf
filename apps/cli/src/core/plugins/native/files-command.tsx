// Native Cordis plugin: file navigator.
//
// Converted from the V1 entry with the same screen id, command name, argsHint
// and description, so existing openers and muscle memory are unaffected. The
// screen and the command are separate effects, each released on disposal.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import type { ScreenContext } from "@codesurf/plugin-api/ui";
import { useTerminalDimensions } from "@opentui/react";
import { createElement } from "react";
import { FileNavigator, type FileNavigatorData } from "../../../ui/ai-output/file-navigator";
import { ScreenOverlay } from "../builtin/screen-overlay";
import { useHostTheme } from "../host-theme";

export const FILES_SCREEN_ID = "screen.files";

export interface FilesScreenProps {
  file: FileNavigatorData;
}

export interface BuildFileNavigatorOptions {
  initialLine?: number;
}

function FilesScreen({ ctx }: { ctx: ScreenContext }) {
  const { width, height } = useTerminalDimensions();
  const props = (ctx.props ?? null) as FilesScreenProps | null;
  const t = useHostTheme();

  ctx.input.useKeyboard((key) => {
    if (key.name === "escape" || key.sequence === "") ctx.close();
  });

  const panelWidth = Math.min(110, width - 4);
  const panelHeight = Math.min(32, height - 4);
  const viewportSize = Math.max(8, panelHeight - 10);

  if (!props) return null;

  const fileWithViewport: FileNavigatorData = {
    ...props.file,
    viewportSize,
  };

  return (
    <ScreenOverlay panelWidth={panelWidth} panelHeight={panelHeight}>
      <box flexShrink={0} flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <text fg={t.primary}>
          <b>{"file navigator"}</b>
        </text>
        <text fg={t.textMuted}>{"esc"}</text>
      </box>
      <FileNavigator t={t} file={fileWithViewport} />
    </ScreenOverlay>
  );
}

function buildDirectoryListing(absolutePath: string, displayPath: string): FileNavigatorData {
  const entries = readdirSync(absolutePath, { withFileTypes: true });
  const lines = entries
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  return {
    path: displayPath,
    lines: lines.length > 0 ? lines : ["(empty directory)"],
    currentLine: 1,
    statusLabel: `${lines.length} entr${lines.length === 1 ? "y" : "ies"}`,
  };
}

function buildFileListing(absolutePath: string, displayPath: string, initialLine = 1): FileNavigatorData {
  const content = readFileSync(absolutePath, "utf8");
  const lines = content.split("\n");
  return {
    path: displayPath,
    lines,
    currentLine: initialLine,
    statusLabel: `${lines.length} line${lines.length === 1 ? "" : "s"}`,
  };
}

function resolveTargetPath(target: string, cwd: string): string {
  if (target.startsWith("file://")) return fileURLToPath(target);
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return join(homedir(), target.slice(2));
  return isAbsolute(target) ? target : resolvePath(cwd, target);
}

export function buildFileNavigatorData(
  target: string,
  cwd: string,
  options: BuildFileNavigatorOptions = {},
): FileNavigatorData {
  const trimmed = target.trim();
  const requested = trimmed.length > 0 ? trimmed : ".";
  const absolute = resolveTargetPath(requested, cwd);
  const displayPath = trimmed.length > 0 ? trimmed : cwd;
  const stat = statSync(absolute);

  return stat.isDirectory()
    ? buildDirectoryListing(absolute, displayPath)
    : buildFileListing(absolute, displayPath, options.initialLine ?? 1);
}

const manifest: PluginManifest = {
  id: "builtin.commands.files",
  name: "File Navigator",
  version: "1.0.0",
  description: "Slash command `/files [path]` opens a navigable view of a directory listing or file contents.",
  enabledByDefault: true,
  protected: false,
  capabilities: ["commands", "screens"],
};

export const filesCommandPlugin: CodesurfPlugin = {
  name: "codesurf-files-command",
  manifest,
  inject: ["contributions", "screens", "chat", "workspace", "ui", "settings"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.screens.registerScreen({
        id: FILES_SCREEN_ID,
        label: "File Navigator",
        render: (screenCtx: ScreenContext) => createElement(FilesScreen, { ctx: screenCtx }),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/files",
        description: "Open the file navigator. Pass a path to view a file; no path lists the agent cwd.",
        argsHint: "[path]",
        handler: ({ args }) => {
          const trimmed = args.trim();
          const cwd = ctx.workspace.cwd();
          const target = trimmed.length > 0 ? trimmed : ".";

          let file: FileNavigatorData;
          try {
            file = buildFileNavigatorData(target, cwd);
          } catch (err) {
            ctx.chat.appendAssistant(`Couldn't open ${target}: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }

          ctx.ui.action({
            type: "open-screen",
            id: FILES_SCREEN_ID,
            props: { file } satisfies FilesScreenProps,
          });
        },
      }),
    );
  },
};

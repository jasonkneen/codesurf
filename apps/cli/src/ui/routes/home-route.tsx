import type { PasteEvent, TextareaRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import os from "os";
import { memo, type RefObject } from "react";
import type { Agent } from "../../agent/agent";
import { getModelInfo } from "../../grok/models";
import { MODES } from "../../types/index";
import type { UpdateCheckResult } from "../../utils/update-checker";
import type { AppStartupConfig } from "../app-helpers.js";
import { HeroLogo } from "../app-helpers.js";
import { PluginStatusIndicators } from "../components/extension-status-indicators.js";
import { PromptModeLabel } from "../components/prompt-bar.js";
import { PromptBox } from "../components/prompt-box.js";
import { useConversationState } from "../context/conversation-state-context.js";
import { useModalNav, useModalVisibility } from "../context/modal-context.js";
import { useModel } from "../context/model-context.js";
import { useTheme } from "../context/theme-context.js";
import type { TypeaheadState } from "../hooks/useTypeahead.js";
import { filterVisibleSlashItems, type SlashMenuItem } from "../slash-menu";
import { SlashMenuInlineLive } from "../slash-menu-inline.js";
import { SHELL_MODE_COLOR } from "../ui-constants.js";

export interface HomeRouteProps {
  agent: Agent;
  processMessage: (text: string, displayText?: string, options?: { continuation?: boolean }) => Promise<void>;
  dispatchExtensionCommand: (commandName: string) => void;
  inputRef: RefObject<TextareaRenderable | null>;
  typeahead: TypeaheadState;
  captureOpen: boolean;
  handleSubmit: () => void;
  handlePaste: (event: PasteEvent) => void;
  startupConfig: AppStartupConfig;
  updateInfo: UpdateCheckResult | null;
  isUpdating: boolean;
  updateOutput: string | null;
  cwdIcon: string;
  shellIcon: string;
  sandboxIcon: string;
  footerPermissionMode: string | null;
  visibleSlashItems: SlashMenuItem[];
}

function HomeRouteImpl({
  agent,
  processMessage: _processMessage,
  dispatchExtensionCommand: _dispatchExtensionCommand,
  inputRef,
  typeahead,
  captureOpen,
  handleSubmit,
  handlePaste,
  startupConfig,
  updateInfo,
  isUpdating,
  updateOutput,
  cwdIcon: _cwdIcon,
  shellIcon: _shellIcon,
  sandboxIcon: _sandboxIcon,
  footerPermissionMode: _footerPermissionMode,
  visibleSlashItems,
}: HomeRouteProps) {
  const { isProcessing, shellMode, pasteBlocks } = useConversationState();
  const { t } = useTheme();
  const { model, mode, sandboxMode, contextStatsRef } = useModel();
  const { showSlashMenu } = useModalVisibility();
  const { slashSearchQuery } = useModalNav();
  const { width: _width } = useTerminalDimensions();

  const slashDisplayItems = filterVisibleSlashItems(visibleSlashItems, slashSearchQuery);

  const modelInfo = getModelInfo(model);
  const modeInfo = MODES.find((m) => m.id === mode)!;
  const contextStats = contextStatsRef.current;

  return (
    <>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box flexGrow={1} minHeight={0} />
        <box flexShrink={0} alignItems="center">
          <HeroLogo t={t} />
        </box>
        <box height={1} minHeight={0} flexShrink={1} />
        {shellMode ? (
          <box
            key="home-composer-shell"
            width="100%"
            maxWidth={75}
            flexShrink={0}
            flexDirection="column"
            border
            borderStyle="rounded"
            borderColor={SHELL_MODE_COLOR}
            paddingLeft={1}
            paddingRight={1}
          >
            {showSlashMenu && <SlashMenuInlineLive t={t} filteredItems={slashDisplayItems} />}
            <PromptBox
              t={t}
              inputRef={inputRef}
              isProcessing={isProcessing}
              shellMode={shellMode}
              captureOpen={captureOpen}
              onSubmit={handleSubmit}
              onPaste={handlePaste}
              pasteBlocks={pasteBlocks}
              model={model}
              modelInfo={modelInfo}
              contextStats={contextStats}
              placeholder="Run a shell command"
              typeahead={typeahead}
            />
          </box>
        ) : (
          <box key="home-composer-opencode" width="100%" maxWidth={75} flexShrink={0} flexDirection="column">
            {showSlashMenu && <SlashMenuInlineLive t={t} filteredItems={slashDisplayItems} />}
            <PromptBox
              t={t}
              inputRef={inputRef}
              isProcessing={isProcessing}
              shellMode={shellMode}
              captureOpen={captureOpen}
              onSubmit={handleSubmit}
              onPaste={handlePaste}
              pasteBlocks={pasteBlocks}
              model={model}
              modelInfo={modelInfo}
              contextStats={contextStats}
              placeholder="What are we building?"
              typeahead={typeahead}
            />
          </box>
        )}
        <box height={2} minHeight={0} flexShrink={1} />
        <box flexGrow={1} minHeight={0} />
      </box>
      {updateInfo?.hasUpdate && (
        <box paddingLeft={2} paddingRight={2} flexDirection="row" flexShrink={0}>
          <text fg="#f59e0b">
            {"┃ Update available: v"}
            {startupConfig.version}
            {" → v"}
            {updateInfo.latestVersion}
            {" — run /update to install"}
          </text>
        </box>
      )}
      {isUpdating && (
        <box paddingLeft={2} paddingRight={2} flexDirection="row" flexShrink={0}>
          <text fg="#f59e0b">{"┃ Updating..."}</text>
        </box>
      )}
      {updateOutput && !isUpdating && (
        <box paddingLeft={2} paddingRight={2} flexDirection="row" flexShrink={0}>
          <text fg={updateOutput.startsWith("Update complete") ? "#22c55e" : "#ef4444"}>
            {"┃ "}
            {updateOutput}
          </text>
        </box>
      )}
      <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="row" flexShrink={0} alignItems="center">
        <text fg={t.textDim}>{agent.getCwd().replace(os.homedir(), "~")}</text>
        {sandboxMode === "shuru" ? <text fg="#f97316">{" · sandbox"}</text> : null}
        {startupConfig.runtimeMode.kind === "server" ? (
          <text fg="#22c55e">{" · wire " + startupConfig.runtimeMode.url}</text>
        ) : (
          <text fg="#22c55e">{" · serverless"}</text>
        )}
        <box flexGrow={1} />
        <PluginStatusIndicators placement="mode-line" />
        <PromptModeLabel t={t} modeInfo={modeInfo} isProcessing={isProcessing} />
        <text fg={t.textDim}>{`  ·  v${startupConfig.version}`}</text>
      </box>
    </>
  );
}

export const HomeRoute = memo(HomeRouteImpl);

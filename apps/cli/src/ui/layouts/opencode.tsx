// opencode session layout.
//
// Wide composer shell: SessionHeader title bar, QueueBanner for pending
// follow-ups, a plain or shell-mode-colored composer, and a cwd/resource
// footer on the left. This is the original/default layout.
//
// Extracted verbatim from app.tsx's `uiMode !== "claude-code"` render branch
// (the `else` of the session-column ternary). Pure render of ctx + center.

import os from "node:os";
import { PluginStatusIndicators } from "../components/extension-status-indicators.js";
import { PermissionModeFooterLabel, PromptModeLabel, WireStatusFooterLabel } from "../components/prompt-bar.js";
import { PromptBox } from "../components/prompt-box.js";
import { QueueBanner } from "../components/queue-banner.js";
import { SessionHeader } from "../components/session-header.js";
import { RunningAgentsFooter } from "../running-agents.js";
import { SlashMenuInlineLive } from "../slash-menu-inline.js";
import { SHELL_MODE_COLOR } from "../ui-constants";
import type { LayoutEntry } from "./types";

export const opencodeLayout: LayoutEntry = {
  id: "opencode",
  label: "OpenCode",
  render: ({ ctx, center }) => {
    const {
      t,
      agent,
      model,
      modelInfo,
      modeInfo,
      isProcessing,
      inputRef,
      shellMode,
      captureOpen,
      pasteBlocks,
      typeahead,
      contextStats,
      onSubmit,
      onPaste,
      queuedMessages,
      queueFocusId,
      runningAgentRows,
      agentsFooterFocused,
      sandboxMode,
      runtimeMode,
      footerPermissionMode,
      showSlashMenu,
      slashDisplayItems,
      footerRightMaxWidth,
      statusSlot,
      cwdIcon,
      shellIcon,
      sandboxIcon,
    } = ctx;

    const composer = shellMode ? (
      <box
        key="composer-shell"
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
          onSubmit={onSubmit}
          onPaste={onPaste}
          pasteBlocks={pasteBlocks}
          model={model}
          modelInfo={modelInfo}
          contextStats={contextStats}
          queuedCount={queuedMessages.length}
          typeahead={typeahead}
        />
      </box>
    ) : (
      <box key="composer-opencode" flexShrink={0} flexDirection="column">
        {showSlashMenu && <SlashMenuInlineLive t={t} filteredItems={slashDisplayItems} />}
        <PromptBox
          t={t}
          inputRef={inputRef}
          isProcessing={isProcessing}
          shellMode={shellMode}
          captureOpen={captureOpen}
          onSubmit={onSubmit}
          onPaste={onPaste}
          pasteBlocks={pasteBlocks}
          model={model}
          modelInfo={modelInfo}
          contextStats={contextStats}
          queuedCount={queuedMessages.length}
          typeahead={typeahead}
        />
      </box>
    );

    return (
      <box flexGrow={1} flexDirection="column">
        <SessionHeader t={t} modeInfo={modeInfo} sessionTitle={null} sessionId={null} />
        {center}
        {statusSlot}
        <QueueBanner t={t} queuedMessages={queuedMessages} focusId={queueFocusId} />
        {composer}
        <RunningAgentsFooter t={t} rows={runningAgentRows} focused={agentsFooterFocused} />
        {/* Bottom chrome — cwd / resource indicators on the left. */}
        <box
          paddingLeft={2}
          paddingRight={2}
          paddingBottom={1}
          flexDirection="row"
          flexShrink={0}
          alignItems="center"
          overflow="hidden"
        >
          <box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" flexDirection="row">
            {shellMode ? (
              <text fg={SHELL_MODE_COLOR} wrapMode="none">
                {shellIcon ? `! ${shellIcon} shell mode` : "! shell mode"}
              </text>
            ) : (
              <>
                <text fg={t.textDim} wrapMode="none">
                  {cwdIcon ? `${cwdIcon} ` : ""}
                  {agent.getCwd().replace(os.homedir(), "~")}
                </text>
                {sandboxMode === "shuru" ? (
                  <text fg="#f97316" wrapMode="none">
                    {sandboxIcon ? ` · ${sandboxIcon} sandbox` : " · sandbox"}
                  </text>
                ) : null}
                <text fg={t.textDim} wrapMode="none">
                  {"  ·  "}
                </text>
                <PluginStatusIndicators placement="mode-line-left" />
              </>
            )}
          </box>
          <box width={1} flexShrink={0} />
          <box
            flexDirection="row"
            alignItems="center"
            justifyContent="flex-end"
            flexShrink={0}
            maxWidth={footerRightMaxWidth}
            overflow="hidden"
          >
            {footerPermissionMode ? <PermissionModeFooterLabel t={t} mode={footerPermissionMode} /> : null}
            <PluginStatusIndicators placement="mode-line" />
            {runtimeMode.kind === "server" ? (
              <WireStatusFooterLabel url={runtimeMode.url} name={runtimeMode.name} />
            ) : (
              <text fg="#22c55e">{"serverless"}</text>
            )}
            <PromptModeLabel t={t} modeInfo={modeInfo} isProcessing={isProcessing} />
          </box>
        </box>
      </box>
    );
  },
};

// claude-code session layout.
//
// Compact session-style chrome: accent-bordered flat composer sitting inside
// the session column, live status embedded in the message list, a
// right-justified todo panel overlay, and contextual shortcut hints on the
// footer left. Success markers (✓ etc.) are accent-colored via the composed
// theme passed in ctx.t.
//
// Extracted verbatim from app.tsx's `uiMode === "claude-code"` render branch.
// Pure render of ctx + center; no hooks, no state, no keyboard handling.

import os from "node:os";
import { PlanUpdate } from "../ai-output/plan-update.js";
import { ClaudeCodePendingMessages } from "../components/claude-code-pending-messages.js";
import { ClaudeCodeTitleBar } from "../components/claude-code-title-bar.js";
import { ComposerShortcutHints } from "../components/composer-shortcut-hints.js";
import { PluginStatusIndicators } from "../components/extension-status-indicators.js";
import { PermissionModeFooterLabel } from "../components/prompt-bar.js";
import { PromptBox } from "../components/prompt-box.js";
import { RunningAgentsFooter } from "../running-agents.js";
import { SlashMenuInlineLive } from "../slash-menu-inline.js";
import { SHELL_MODE_COLOR } from "../ui-constants";
import type { LayoutEntry } from "./types";

export const claudeCodeLayout: LayoutEntry = {
  id: "claude-code",
  label: "Claude Code",
  render: ({ ctx, center }) => {
    const {
      t,
      agent,
      width,
      model,
      modelInfo,
      isProcessing,
      inputRef,
      shellMode,
      captureOpen,
      pasteBlocks,
      typeahead,
      contextStats,
      cacheStatsLine,
      onSubmit,
      onPaste,
      queuedMessages,
      queueFocusId,
      todoPlan,
      showTodoPanel,
      onToggleTodoPanel,
      runningAgentRows,
      agentsFooterFocused,
      sandboxMode,
      runtimeMode,
      footerPermissionMode,
      showSlashMenu,
      slashDisplayItems,
      composerShortcutHints,
      composerChromeBottomTitle,
      compactFooterHints,
      footerRightMaxWidth,
      statusSlot,
      sandboxIcon,
    } = ctx;

    return (
      <box flexGrow={1} flexDirection="column">
        <ClaudeCodeTitleBar
          t={t}
          cwd={agent.getCwd()}
          homeDir={os.homedir()}
          contextStats={contextStats}
          queuedCount={queuedMessages.length}
          cacheStatsLine={cacheStatsLine}
        />
        {center}
        {statusSlot}
        <ClaudeCodePendingMessages t={t} queuedMessages={queuedMessages} focusId={queueFocusId} />
        {/* Todo panel — toggled by the list icon in the composer. Floats
            above the input, right-justified, and stays open until toggled. */}
        {showTodoPanel && todoPlan ? (
          <box flexShrink={0} flexDirection="row" justifyContent="flex-end" marginBottom={1}>
            <box
              flexShrink={1}
              flexDirection="column"
              border
              borderStyle="rounded"
              borderColor={t.accent}
              paddingLeft={1}
              paddingRight={1}
            >
              <PlanUpdate t={t} plan={todoPlan} />
            </box>
          </box>
        ) : null}
        {/* Composer — accent-colored rounded border (termcast-style), flat input. */}
        <box
          key="composer-claude-code"
          flexShrink={0}
          flexDirection="column"
          border
          borderStyle="rounded"
          borderColor={shellMode ? SHELL_MODE_COLOR : t.accent}
          bottomTitle={composerChromeBottomTitle}
          bottomTitleAlignment="right"
          marginLeft={1}
          marginRight={1}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={0}
          paddingBottom={0}
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
            textareaWidth={width}
            hasTodos={!!todoPlan}
            onToggleTodoPanel={onToggleTodoPanel}
            flat
          />
        </box>
        <RunningAgentsFooter t={t} rows={runningAgentRows} focused={agentsFooterFocused} />
        {/* Bottom chrome — contextual shortcut hints on the left. */}
        <box
          paddingLeft={2}
          paddingRight={2}
          paddingBottom={1}
          flexDirection="row"
          flexShrink={0}
          alignItems="center"
          overflow="hidden"
        >
          <box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            <ComposerShortcutHints t={t} hints={composerShortcutHints} compact={compactFooterHints} />
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
            {sandboxMode === "shuru" ? (
              <text fg="#f97316" wrapMode="none">
                {sandboxIcon ? `${sandboxIcon} ` : ""}
                {"sandbox  ·  "}
              </text>
            ) : null}
            {footerPermissionMode ? <PermissionModeFooterLabel t={t} mode={footerPermissionMode} /> : null}
            <PluginStatusIndicators trailingSeparator=" · " t={t} />
            <PluginStatusIndicators placement="mode-line" />
            {runtimeMode.kind === "server" ? (
              <text fg="#4c8dff">{`wire ${runtimeMode.url}`}</text>
            ) : (
              <text fg="#22c55e">{"serverless"}</text>
            )}
          </box>
        </box>
      </box>
    );
  },
};

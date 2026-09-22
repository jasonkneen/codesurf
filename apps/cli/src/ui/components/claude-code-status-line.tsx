// Live turn status line — one row above the composer, shared by both layouts.
//
// Phase comes from what the stream last did (see stream-store's StreamPhase)
// plus the live tool list: a running tool wins, then writing (text deltas),
// thinking (reasoning deltas), and finally waiting/connecting. The right-hand
// side always shows time since the turn started; during a tool it also shows
// that tool's own clock.

import { useEffect, useState } from "react";
import { useIcon } from "../../core/plugins";
import type { ToolCall } from "../../types/index";
import { truncate } from "../../utils/text";
import { type StreamPhase, useStreamPhase } from "../stream-store.js";
import type { Theme } from "../theme";
import { LoadingSpinner } from "./loading-spinner.js";
import { toolArgs, tryParseArg } from "./tool-format.js";

export type ClaudeCodeStatusPhase = "connecting" | "waiting" | "thinking" | "writing" | "tool" | "stopped";

export interface ClaudeCodeStatusLineModel {
  phase: ClaudeCodeStatusPhase;
  /** Tool verb for `:: Run <verb> \`detail\`` — only when phase === "tool". */
  toolVerb?: string;
  toolDetail?: string;
  /** Other tools running alongside the head tool. */
  extraToolCount?: number;
  /** When the head tool started, for its own clock. */
  toolStartedAtMs?: number;
  elapsedMs: number;
  /** When the turn started; the line ticks its own clock from this. */
  startedAtMs?: number;
}

export interface ClaudeCodeStatusInputs {
  activeToolCalls: ToolCall[];
  isProcessing: boolean;
  justStopped: boolean;
  /** Frozen elapsed for the stopped state. */
  elapsedMs: number;
  startedAtMs?: number;
  toolStartedAtMs?: number;
  homeDir: string;
}

function shortenPath(path: string, homeDir: string): string {
  if (path.startsWith(homeDir)) return `~${path.slice(homeDir.length)}`;
  return path;
}

/** Map the live turn state to a status model, or null when there is nothing to show. */
export function buildClaudeCodeStatusModel(
  params: ClaudeCodeStatusInputs & { streamPhase: StreamPhase | null },
): ClaudeCodeStatusLineModel | null {
  const { activeToolCalls, isProcessing, justStopped, elapsedMs, startedAtMs, toolStartedAtMs, homeDir, streamPhase } =
    params;

  if (justStopped) {
    return { phase: "stopped", elapsedMs };
  }
  if (!isProcessing) return null;

  const tool = activeToolCalls[0];
  if (tool) {
    const { verb, detail } = formatToolStatusParts(tool, homeDir);
    return {
      phase: "tool",
      toolVerb: verb,
      toolDetail: detail,
      extraToolCount: activeToolCalls.length - 1,
      toolStartedAtMs,
      elapsedMs,
      startedAtMs,
    };
  }
  const phase: ClaudeCodeStatusPhase = streamPhase ?? "waiting";
  return { phase, elapsedMs, startedAtMs };
}

function formatToolStatusParts(tc: ToolCall, homeDir: string): { verb: string; detail?: string } {
  const name = tc.function.name;
  const path = tryParseArg(tc, "path") || tryParseArg(tc, "file_path") || toolArgs(tc);

  switch (name) {
    case "read_file":
      return { verb: "Read", detail: path ? shortenPath(path, homeDir) : undefined };
    case "write_file":
      return { verb: "Write", detail: path ? shortenPath(path, homeDir) : undefined };
    case "edit_file":
      return { verb: "Edit", detail: path ? shortenPath(path, homeDir) : undefined };
    case "bash": {
      const cmd = tryParseArg(tc, "command") || toolArgs(tc);
      return { verb: "Bash", detail: cmd ? truncate(cmd, 72) : undefined };
    }
    case "grep":
      return { verb: "Grep", detail: truncate(tryParseArg(tc, "pattern") || toolArgs(tc), 72) || undefined };
    case "glob":
      return { verb: "Glob", detail: truncate(tryParseArg(tc, "pattern") || toolArgs(tc), 72) || undefined };
    case "task":
      return { verb: "Task", detail: truncate(toolArgs(tc), 72) || undefined };
    case "delegate":
      return { verb: "Delegate", detail: truncate(toolArgs(tc), 72) || undefined };
    default: {
      const verb = name
        .split("_")
        .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ""))
        .join("");
      const raw = toolArgs(tc);
      return { verb: verb || name, detail: raw ? truncate(raw, 72) : undefined };
    }
  }
}

export function formatStatusElapsed(ms: number, precise: boolean): string {
  const sec = Math.max(0, ms / 1000);
  if (precise && sec < 60) return `${sec.toFixed(1)}s`;
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec - m * 60);
    return `${m}m${String(s).padStart(2, "0")}s`;
  }
  return `${Math.round(sec)}s`;
}

const PHASE_LABEL: Record<Exclude<ClaudeCodeStatusPhase, "tool">, string> = {
  connecting: "Connecting…",
  waiting: "Waiting for model…",
  thinking: "Thinking…",
  writing: "Writing…",
  stopped: "Stopped ·",
};

export function formatClaudeCodeStatusLabel(model: ClaudeCodeStatusLineModel, elapsed: string): string {
  const base = model.phase === "tool" ? "Running…" : PHASE_LABEL[model.phase];
  return `${base} ${elapsed}`;
}

/** ` +N more` suffix for concurrent tools, empty when there is only one. */
export function formatExtraToolCount(extra: number | undefined): string {
  if (!extra || extra <= 0) return "";
  return ` +${extra} more`;
}

export function formatClaudeCodeCancelGlyph(closeIcon: string): string {
  return closeIcon || "[x]";
}

export function ClaudeCodeStatusLine({
  t,
  inputs,
  onCancel,
}: {
  t: Theme;
  inputs: ClaudeCodeStatusInputs;
  onCancel: () => void;
}) {
  const streamPhase = useStreamPhase();
  const model = buildClaudeCodeStatusModel({ ...inputs, streamPhase });
  const closeIcon = useIcon("close");
  const ticking = !!model && model.phase !== "stopped" && !!model.startedAtMs;
  const precise = model?.phase === "tool";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), precise ? 100 : 1000);
    return () => clearInterval(id);
  }, [ticking, precise]);

  if (!model) return null;

  const turnElapsedMs = ticking && model.startedAtMs ? now - model.startedAtMs : model.elapsedMs;
  const turnElapsed = formatStatusElapsed(turnElapsedMs, false);
  const toolElapsed =
    model.phase === "tool" && model.toolStartedAtMs ? formatStatusElapsed(now - model.toolStartedAtMs, true) : null;

  const left =
    model.phase === "tool" ? (
      <text fg={t.textMuted} wrapMode="none">
        {":: Run "}
        <span style={{ fg: t.accent }}>{model.toolVerb}</span>
        {model.toolDetail ? (
          <>
            {" "}
            <span style={{ fg: t.accent }}>{`\`${model.toolDetail}\``}</span>
          </>
        ) : null}
        <span style={{ fg: t.textDim }}>{formatExtraToolCount(model.extraToolCount)}</span>
      </text>
    ) : (
      <text fg={t.textMuted} wrapMode="none">
        {model.phase === "stopped" ? (
          "· "
        ) : (
          <>
            <span style={{ fg: t.accent }}>
              <LoadingSpinner />
            </span>{" "}
          </>
        )}
        <span style={{ fg: t.text }}>{formatClaudeCodeStatusLabel(model, turnElapsed)}</span>
      </text>
    );

  return (
    <box flexShrink={0} marginTop={1}>
      <box flexDirection="row" height={1} alignItems="center" paddingLeft={2} paddingRight={2} flexShrink={0}>
        {left}
        <box flexGrow={1} />
        <box flexDirection="row" gap={0} alignItems="center" onMouseDown={onCancel}>
          <text fg={t.textMuted} wrapMode="none">
            {toolElapsed ? (
              <>
                <span style={{ fg: t.text }}>{toolElapsed}</span>
                <span style={{ fg: t.textDim }}>{` · ${turnElapsed}`}</span>
              </>
            ) : null}{" "}
            <span style={{ fg: t.textDim }}>{formatClaudeCodeCancelGlyph(closeIcon)}</span>
          </text>
        </box>
      </box>
    </box>
  );
}

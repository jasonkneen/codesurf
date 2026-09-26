import { useEffect, useState } from "react";
import { useIcon } from "../../core/plugins";
import type { Theme } from "../theme";

const PROMPT_LOADING_FRAMES = [
  { active: 0, forward: true },
  { active: 1, forward: true },
  { active: 2, forward: true },
  { active: 1, forward: false },
] as const;

function promptLoadingCellGlyph(index: number, active: number, forward: boolean): string {
  const distance = forward ? active - index : index - active;
  return distance >= 0 && distance < 2 ? "■" : "⬝";
}

function promptLoadingCellColor(color: string, index: number, active: number, forward: boolean): string {
  const distance = forward ? active - index : index - active;
  if (distance === 0) return color;
  if (distance === 1) return withAlpha(color, 0.72);
  return withAlpha(color, 0.22);
}

function withAlpha(color: string, alpha: number): string {
  const normalized = color.trim();
  const hex = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hex) return color;

  const body = hex[1];
  const expanded =
    body.length === 3
      ? body
          .split("")
          .map((ch) => ch + ch)
          .join("")
      : body;

  const alphaHex = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${expanded}${alphaHex}`;
}

export function PromptLoadingBoxes({ t: _t, color }: { t: Theme; color: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame((n) => (n + 1) % PROMPT_LOADING_FRAMES.length), 120);
    return () => clearInterval(id);
  }, []);

  const step = PROMPT_LOADING_FRAMES[frame] ?? PROMPT_LOADING_FRAMES[0];

  return (
    <text>
      {[0, 1, 2].map((idx) => (
        <span key={idx} style={{ fg: promptLoadingCellColor(color, idx, step.active, step.forward) }}>
          {promptLoadingCellGlyph(idx, step.active, step.forward)}
        </span>
      ))}
    </text>
  );
}

export interface PromptModeInfo {
  id: string;
  label: string;
  color: string;
}

export function PromptModeLabel({
  t,
  modeInfo,
  isProcessing,
}: {
  t: Theme;
  modeInfo: PromptModeInfo;
  isProcessing: boolean;
}) {
  // Agent mode follows the active theme's primary so it matches the rest of
  // the brand (e.g. nerv's orange) instead of the static blue baked into
  // `MODES`. Plan/ask keep their semantic colors (gold/green) because they
  // signal *workflow state*, not theme identity.
  const color = modeInfo.id === "agent" ? t.primary : modeInfo.color;

  const icon = useIcon(modeInfo.id);

  if (!isProcessing) {
    return (
      <text fg={color}>
        <b>
          {icon ? `${icon} ` : ""}
          {modeInfo.label}
        </b>
      </text>
    );
  }

  return <PromptLoadingBoxes t={t} color={color} />;
}

function permissionModeFooterText(mode: string): string {
  switch (mode) {
    case "bypassPermissions":
      return "yolo";
    case "acceptEdits":
      return "edits";
    case "plan":
      return "plan";
    case "dontAsk":
      return "dont-ask";
    case "auto":
      return "auto";
    default:
      return "ask";
  }
}

/** Composer bottom border — ` Grok Build 0.1 · Agent ` (spaces for frame gaps). */
export function formatComposerChromeLabel(modelName: string, modeLabel: string): string {
  return ` ${modelName} · ${modeLabel} `;
}

/** Claude-code composer chrome — matches Cursor/Grok Build phrasing. */
export function permissionModeComposerLabel(mode: string): string {
  switch (mode) {
    case "bypassPermissions":
      return "always-approve";
    case "acceptEdits":
      return "accept-edits";
    case "plan":
      return "plan";
    case "dontAsk":
      return "dont-ask";
    case "auto":
      return "auto";
    default:
      return "ask";
  }
}

export function PermissionModeFooterLabel({ t, mode }: { t: Theme; mode: string }) {
  const icon = useIcon("permission");
  return (
    <text fg={t.textMuted} wrapMode="none">
      {icon ? `${icon} ` : ""}
      {icon ? "" : "perm "}
      <span style={{ fg: t.text }}>{permissionModeFooterText(mode)}</span>
      {" · "}
    </text>
  );
}

/**
 * Footer status for a server-mode session. Shows a human label ("● default:
 * connected") instead of the raw ws:// URL; click to reveal the URL, click
 * again to collapse.
 */
export function WireStatusFooterLabel({ url, name }: { url: string; name?: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <text fg="#4c8dff" wrapMode="none" onMouseDown={() => setRevealed((v) => !v)}>
      {revealed ? url : `● ${name || "Server"}: connected`}
    </text>
  );
}

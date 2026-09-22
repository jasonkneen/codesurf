import type { ReactNode } from "react";
import type { Theme } from "../theme";

export interface ShortcutHint {
  keys: string;
  label: string;
}

export interface ComposerShortcutHintsContext {
  isProcessing: boolean;
  shellMode: boolean;
  queuedCount: number;
  queueFocused: boolean;
  typeaheadVisible: boolean;
  runningAgentsCount: number;
}

/**
 * Build contextual composer shortcut hints — only bindings codesurf actually
 * implements. Returns an empty list when nothing worth surfacing.
 */
export function buildComposerShortcutHints(ctx: ComposerShortcutHintsContext): ShortcutHint[] {
  if (ctx.shellMode) {
    return [
      { keys: "enter", label: "run" },
      { keys: "esc", label: "exit" },
    ];
  }

  if (ctx.typeaheadVisible) {
    return [
      { keys: "tab", label: "accept" },
      { keys: "↑↓", label: "nav" },
      { keys: "esc", label: "dismiss" },
    ];
  }

  if (ctx.queueFocused && ctx.queuedCount > 0) {
    return [
      { keys: "↑↓", label: "queue" },
      { keys: "enter", label: "send" },
      { keys: "esc", label: "back" },
    ];
  }

  if (ctx.isProcessing) {
    const hints: ShortcutHint[] = [
      { keys: "shift+tab", label: "mode" },
      { keys: "ctrl+x", label: "stop" },
      { keys: "enter", label: "queue" },
    ];
    if (ctx.queuedCount === 1) hints.push({ keys: "↑", label: "send now" });
    else if (ctx.queuedCount > 1) hints.push({ keys: "↑", label: "queue" });
    return hints;
  }

  const hints: ShortcutHint[] = [
    { keys: "shift+tab", label: "mode" },
    { keys: "ctrl+k", label: "commands" },
  ];
  if (ctx.runningAgentsCount > 0) hints.push({ keys: "↓", label: "agents" });
  return hints;
}

export function formatShortcutKeys(keys: string, compact = false): string {
  if (!compact) return keys;
  switch (keys) {
    case "shift+tab":
      return "⇧tab";
    case "ctrl+x":
      return "^x";
    case "ctrl+k":
      return "^k";
    default:
      return keys;
  }
}

export function formatShortcutLabel(label: string, compact = false): string {
  if (!compact) return label;
  switch (label) {
    case "commands":
      return "cmds";
    case "send now":
      return "send";
    default:
      return label;
  }
}

export function ComposerShortcutHints({
  t,
  hints,
  compact = false,
}: {
  t: Theme;
  hints: ShortcutHint[];
  compact?: boolean;
}) {
  if (hints.length === 0) return null;

  const parts: ReactNode[] = [];
  for (let i = 0; i < hints.length; i++) {
    const h = hints[i]!;
    const keys = formatShortcutKeys(h.keys, compact);
    const label = formatShortcutLabel(h.label, compact);
    if (i > 0) parts.push(" | ");
    parts.push(
      <span key={`${h.keys}-${h.label}`} style={{ fg: t.text }}>
        {keys}
      </span>,
    );
    parts.push(<span key={`${h.keys}-${h.label}-colon`} style={{ fg: t.textMuted }}>{`:${label}`}</span>);
  }

  return (
    <text fg={t.textMuted} wrapMode="none">
      {parts}
    </text>
  );
}

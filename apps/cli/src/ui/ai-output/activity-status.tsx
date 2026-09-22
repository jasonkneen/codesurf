// ActivityStatus — single-line status indicator with tone-coded icon and
// optional elapsed + hint + interruptible marker. Ported from termcast's
// agent-output/activity-status.tsx.
//
// The active-tone icon is a braille spinner so the line visibly proves the
// run is alive (a static bullet looked stalled). done/error/pending keep
// their static glyphs.

import { useEffect, useState } from "react";
import type { Theme } from "../theme";

export type ActivityTone = "active" | "done" | "warning" | "error" | "pending";

export interface ActivityStatusData {
  label: string;
  elapsed?: string;
  hint?: string;
  detail?: string;
  tone?: ActivityTone;
  isInterruptible?: boolean;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function useBrailleFrame(active: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setFrame((n) => (n + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, [active]);
  return SPINNER_FRAMES[frame];
}

function toneColor(t: Theme, tone: ActivityTone): string {
  switch (tone) {
    case "done":
      return t.diffAddedFg;
    case "warning":
      return t.accent;
    case "error":
      return t.diffRemovedFg;
    case "pending":
      return t.textMuted;
    default:
      return t.accent;
  }
}

export function ActivityStatus({ t, activity }: { t: Theme; activity: ActivityStatusData }) {
  const tone = activity.tone ?? "active";
  const color = toneColor(t, tone);
  const spinner = useBrailleFrame(tone === "active");
  const icon = tone === "done" ? "✓" : tone === "error" ? "✗" : tone === "active" ? spinner : "•";
  const metaParts = [activity.elapsed, activity.hint, activity.isInterruptible ? "esc to interrupt" : undefined].filter(
    (v): v is string => Boolean(v),
  );
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} marginBottom={1}>
      <box flexDirection="row" height={1}>
        <box width={2} flexShrink={0}>
          <text fg={color} wrapMode="none">
            {icon}
          </text>
        </box>
        <text fg={color} wrapMode="none">
          <b>{activity.label}</b>
        </text>
        {metaParts.length > 0 && (
          <text fg={t.textMuted} wrapMode="none">
            {` (${metaParts.join(" • ")})`}
          </text>
        )}
      </box>
      {activity.detail && (
        <box paddingLeft={2}>
          <text fg={t.textMuted}>{activity.detail}</text>
        </box>
      )}
    </box>
  );
}

export function makeExampleActivity(): ActivityStatusData {
  return {
    label: "Working",
    elapsed: "1m 06s",
    isInterruptible: true,
    detail: "Scanning the current workspace, tightening state flow, and applying the next patch set.",
    tone: "active",
  };
}

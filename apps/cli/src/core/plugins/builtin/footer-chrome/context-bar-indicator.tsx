// Context bar indicator — block-bar meter for context-window usage.
//
// Reads context stats each render through the `getStats` prop. The host
// (app.tsx) re-renders
// per turn (and during streaming), so the meter refreshes naturally without any
// dedicated subscription. Returns null when stats are unavailable (headless
// boot, model still resolving).
//
// Visual: `██████░░░░  47%  47k / 200k`
//
//   - Bar: 10 cells; Nerd Font square glyphs when /nerd-icons is enabled,
//     otherwise terminal-safe `█` filled and `░` empty fallback glyphs.
//   - Percent: integer percent
//   - Tokens: short-form `Nk` (e.g. `1.2k` for <10k, `47k` for ≥10k)
//
// Color thresholds:
//   < 60%  → dim grey (informational)
//   60-85% → amber (heads-up)
//   ≥ 85%  → red (compaction soon)

import type { ContextStats } from "../../api";
import { useIcon } from "../../icons";

const BAR_CELLS = 10;
const FALLBACK_PROGRESS_FULL = "█";
const FALLBACK_PROGRESS_EMPTY = "░";

const COLOR_DIM = "#606060";
const COLOR_VALUE = "#cfcfcf";
const COLOR_BAR_FILL_LOW = "#7a7a7a";
const COLOR_BAR_FILL_MID = "#d0a050";
const COLOR_BAR_FILL_HIGH = "#d05050";
const COLOR_BAR_EMPTY = "#3a3a3a";

/**
 * Narrow props, not the host services facade.
 *
 * This component is rendered by a plugin, and `@codesurf/plugin-api`
 * deliberately does not expose the whole facade. Two readers are all it ever
 * used, so the caller passes those two — which also means the component is
 * testable without standing up a host.
 */
export interface ContextBarIndicatorProps {
  getSetting: (key: string, fallback: boolean) => boolean;
  getStats: () => ContextStats | null;
}

export function ContextBarIndicator({ getSetting, getStats }: ContextBarIndicatorProps) {
  const contextIcon = useIcon("context_meter");
  const progressFullIcon = useIcon("progress_full");
  const progressEmptyIcon = useIcon("progress_empty");
  const showBar = getSetting("contextBar.show.bar", true);
  const showPercent = getSetting("contextBar.show.percent", true);
  const showTokens = getSetting("contextBar.show.tokens", true);

  if (!showBar && !showPercent && !showTokens) return null;

  const stats: ContextStats | null = getStats();
  if (!stats) return null;

  const pct = Math.max(0, Math.min(1, stats.ratioUsed));
  const filled = computeFilledCells(pct, BAR_CELLS);
  const fillColor = pct >= 0.85 ? COLOR_BAR_FILL_HIGH : pct >= 0.6 ? COLOR_BAR_FILL_MID : COLOR_BAR_FILL_LOW;

  // Build the bar in two segments so we can color filled vs empty
  // independently while still allowing the Nerd Font extension to swap the
  // glyphs.
  const { filledStr, emptyStr } = formatContextBarSegments(filled, BAR_CELLS, {
    full: progressFullIcon,
    empty: progressEmptyIcon,
  });

  const percentStr = `${Math.round(pct * 100)}%`;
  const tokenStr = `${formatTokens(stats.usedTokens)} / ${formatTokens(stats.contextWindow)}`;

  return (
    <text fg={COLOR_DIM} wrapMode="none">
      {contextIcon ? <span style={{ fg: COLOR_VALUE }}>{`${contextIcon} `}</span> : null}
      {showBar && (
        <>
          <span style={{ fg: fillColor }}>{filledStr}</span>
          <span style={{ fg: COLOR_BAR_EMPTY }}>{emptyStr}</span>
          {showPercent || showTokens ? "  " : ""}
        </>
      )}
      {showPercent && (
        <>
          <span style={{ fg: COLOR_VALUE }}>{percentStr}</span>
          {showTokens ? "  " : ""}
        </>
      )}
      {showTokens && <span style={{ fg: COLOR_VALUE }}>{tokenStr}</span>}
      {"  ·  "}
    </text>
  );
}

export function formatContextBarSegments(
  filled: number,
  total = BAR_CELLS,
  glyphs: { full?: string | null; empty?: string | null } = {},
): { filledStr: string; emptyStr: string } {
  const clampedFilled = Math.max(0, Math.min(total, filled));
  const full = glyphs.full || FALLBACK_PROGRESS_FULL;
  const empty = glyphs.empty || FALLBACK_PROGRESS_EMPTY;
  return {
    filledStr: full.repeat(clampedFilled),
    emptyStr: empty.repeat(Math.max(0, total - clampedFilled)),
  };
}

/** Filled-cell count for the bar. Returns 0 only at exactly 0% usage; any
 *  non-zero usage shows at least one pip so the meter reads "on" the moment
 *  context is consumed (round() alone floors anything under 5% to zero cells). */
export function computeFilledCells(pct: number, total = BAR_CELLS): number {
  const clamped = Math.max(0, Math.min(1, pct));
  if (clamped <= 0) return 0;
  return Math.max(1, Math.round(clamped * total));
}

function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 10_000) {
    const k = n / 1_000;
    return `${k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

import { useIcon } from "../../core/plugins";
import type { Theme } from "../theme";

export interface ContextStats {
  contextWindow: number;
  usedTokens: number;
  remainingTokens: number;
  ratioUsed: number;
  ratioRemaining: number;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export function ContextMeter({ t, stats }: { t: Theme; stats: ContextStats }) {
  const icon = useIcon("context_meter");
  return (
    <text>
      {icon ? <span style={{ fg: t.textMuted }}>{`${icon} `}</span> : null}
      <span style={{ fg: t.textMuted }}>{`${Math.round(stats.ratioRemaining * 100)}%`}</span>
      <span style={{ fg: t.textDim }}>{` ${formatTokenCount(stats.remainingTokens)}`}</span>
    </text>
  );
}

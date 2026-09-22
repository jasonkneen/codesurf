import { useIcon } from "../../core/plugins";
import type { Theme } from "../theme";
import type { ContextStats } from "./context-meter";

export function formatContextTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 10_000) {
    const k = n / 1_000;
    return `${k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  if (n < 1_000_000) return `${Math.round(n / 1_000)}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** `73K / 200K` or `| 73K / 200K | +3 |` when variant is footer. */
export function formatContextStatusText(
  stats: ContextStats,
  queuedCount = 0,
  variant: "title" | "footer" = "title",
): string {
  const usage = `${formatContextTokens(stats.usedTokens)} / ${formatContextTokens(stats.contextWindow)}`;
  if (variant === "title") return usage;
  if (queuedCount > 0) return `| ${usage} | +${queuedCount} |`;
  return `| ${usage} |`;
}

export function ClaudeCodeContextCount({
  t,
  stats,
  queuedCount = 0,
  variant = "title",
}: {
  t: Theme;
  stats: ContextStats;
  queuedCount?: number;
  variant?: "title" | "footer";
}) {
  const usage = `${formatContextTokens(stats.usedTokens)} / ${formatContextTokens(stats.contextWindow)}`;
  const contextIcon = useIcon("context_meter");
  const icon = contextIcon ? `${contextIcon} ` : "";

  if (variant === "footer") {
    return (
      <text fg={t.textMuted} wrapMode="none">
        <span style={{ fg: t.textDim }}>{"| "}</span>
        {icon ? <span style={{ fg: t.textMuted }}>{icon}</span> : null}
        <span style={{ fg: t.text }}>{usage}</span>
        <span style={{ fg: t.textDim }}>{" |"}</span>
        {queuedCount > 0 ? (
          <>
            <span style={{ fg: t.text }}>{` +${queuedCount}`}</span>
            <span style={{ fg: t.textDim }}>{" |"}</span>
          </>
        ) : null}
      </text>
    );
  }

  return (
    <text fg={t.textMuted} wrapMode="none">
      <span style={{ fg: t.textDim }}>{" | "}</span>
      {icon ? <span style={{ fg: t.textMuted }}>{icon}</span> : null}
      <span style={{ fg: t.text }}>{usage}</span>
      {queuedCount > 0 ? <span style={{ fg: t.text }}>{` +${queuedCount}`}</span> : null}
    </text>
  );
}

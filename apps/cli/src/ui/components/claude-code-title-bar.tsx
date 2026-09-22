import { useEffect, useMemo, useState } from "react";
import { useIcon } from "../../core/plugins";
import { type GitWorkspaceInfo, getGitWorkspaceInfo } from "../../utils/git-workspace";
import type { Theme } from "../theme";
import { ClaudeCodeContextCount } from "./claude-code-context-count";
import type { ContextStats } from "./context-meter";

function shortenPath(cwd: string, home: string): string {
  if (cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

function workspaceLabel(info: GitWorkspaceInfo): string | null {
  if (info.worktreeLabel) return info.worktreeLabel;
  if (info.branch) return info.branch;
  return null;
}

/** Nerd Font bolt when extension is on; emoji fallback otherwise. */
export function titleBarBrandGlyph(nerdIcon: string): string {
  return nerdIcon ? `${nerdIcon} ` : "⚡ ";
}

export function ClaudeCodeTitleBar({
  t,
  cwd,
  homeDir,
  contextStats,
  queuedCount = 0,
  cacheStatsLine,
}: {
  t: Theme;
  cwd: string;
  homeDir: string;
  contextStats?: ContextStats | null;
  queuedCount?: number;
  /** Prefix-cache health for the last turn, from `Agent.getLastCacheStatsLine()`.
   *  Large `read` / small `written` is healthy; a large `written` on a later
   *  turn means a prompt section ahead of the cached span changed. */
  cacheStatsLine?: string | null;
}) {
  const [gitInfo, setGitInfo] = useState<GitWorkspaceInfo>(() => getGitWorkspaceInfo(cwd));

  useEffect(() => {
    setGitInfo(getGitWorkspaceInfo(cwd));
  }, [cwd]);

  const pathLabel = useMemo(() => shortenPath(cwd, homeDir), [cwd, homeDir]);
  const branchOrWorktree = workspaceLabel(gitInfo);
  const brandIcon = useIcon("codesurf");

  return (
    <box
      flexShrink={0}
      flexDirection="row"
      height={1}
      marginTop={1}
      paddingLeft={2}
      paddingRight={2}
      alignItems="center"
    >
      <box flexShrink={0} flexDirection="row">
        <text fg={t.text} wrapMode="none">
          <span style={{ fg: t.accent }}>{titleBarBrandGlyph(brandIcon)}</span>
          <span style={{ fg: t.text }}>{"codesurf"}</span>
          {branchOrWorktree ? <span style={{ fg: t.textMuted }}>{` ${branchOrWorktree}`}</span> : null}
          <span style={{ fg: t.textMuted }}>{` ${pathLabel}`}</span>
        </text>
      </box>
      {/* The cache/skills line is the least important thing on this row, so it
          is the one that gives up space. Without this the stats string pushed
          the cwd out of the bar. */}
      {cacheStatsLine ? (
        <box flexShrink={1} minWidth={0} overflow="hidden">
          <text fg={t.textDim} wrapMode="none">
            {`  ${cacheStatsLine}`}
          </text>
        </box>
      ) : null}
      <box flexGrow={1} />
      {contextStats ? (
        <ClaudeCodeContextCount t={t} stats={contextStats} queuedCount={queuedCount} variant="footer" />
      ) : null}
    </box>
  );
}

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface GitWorkspaceInfo {
  branch: string | null;
  /** Linked worktree directory name, when cwd is not the primary checkout. */
  worktreeLabel: string | null;
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function linkedWorktreeLabel(cwd: string): string | null {
  const gitPath = join(cwd, ".git");
  if (!existsSync(gitPath)) return null;
  try {
    if (!statSync(gitPath).isFile()) return null;
  } catch {
    return null;
  }
  const label = basename(cwd);
  return label || null;
}

/** Best-effort git branch + worktree label for the composer title bar. */
export function getGitWorkspaceInfo(cwd: string): GitWorkspaceInfo {
  const branchRaw = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRaw && branchRaw !== "HEAD" ? branchRaw : null;
  const worktreeLabel = linkedWorktreeLabel(cwd);
  return { branch, worktreeLabel };
}

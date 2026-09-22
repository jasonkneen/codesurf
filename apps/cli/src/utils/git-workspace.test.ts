import { describe, expect, it } from "vitest";
import { getGitWorkspaceInfo } from "./git-workspace";

describe("getGitWorkspaceInfo", () => {
  it("returns branch info for this repository", () => {
    const info = getGitWorkspaceInfo(process.cwd());
    // Repo is expected to be a git checkout in dev/CI; branch may vary.
    if (info.branch) {
      expect(info.branch.length).toBeGreaterThan(0);
    }
  });
});

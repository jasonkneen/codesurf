import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEditApprovalSession, shouldAutoApproveEditWithLoader } from "./file-tools-approval";

describe("shouldAutoApproveEditWithLoader settings readability", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-edit-approval-test-"));
    resetEditApprovalSession();
  });

  afterEach(() => {
    resetEditApprovalSession();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("preserves accept-all when the settings file is absent", () => {
    const missingSettingsPath = path.join(tempDir, "missing-user-settings.json");

    expect(shouldAutoApproveEditWithLoader("/tmp/edit-target", () => "accept-all", missingSettingsPath)).toBe(true);
  });

  it("fails closed when the settings file is corrupt", () => {
    const corruptSettingsPath = path.join(tempDir, "user-settings.json");
    fs.writeFileSync(corruptSettingsPath, "{not json");

    expect(shouldAutoApproveEditWithLoader("/tmp/edit-target", () => "accept-all", corruptSettingsPath)).toBe(false);
  });

  it("returns true for readable settings when mode is accept-all", () => {
    const settingsPath = path.join(tempDir, "user-settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ editApproval: "accept-all" }));

    expect(shouldAutoApproveEditWithLoader("/tmp/edit-target", () => "accept-all", settingsPath)).toBe(true);
  });

  it("returns false for readable settings when mode is not accept-all", () => {
    const settingsPath = path.join(tempDir, "user-settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ editApproval: "ask-always" }));

    expect(shouldAutoApproveEditWithLoader("/tmp/edit-target", () => "ask-always", settingsPath)).toBe(false);
  });
});

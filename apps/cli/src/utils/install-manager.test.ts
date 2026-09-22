import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildScriptUninstallPlan,
  getInstallMetadataPath,
  getReleaseTargetForPlatform,
  getScriptInstallContext,
  getScriptInstallDir,
  loadScriptInstallMetadata,
  parseChecksumsFile,
  saveScriptInstallMetadata,
} from "./install-manager";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("getReleaseTargetForPlatform", () => {
  it("maps supported platforms to release asset names", () => {
    expect(getReleaseTargetForPlatform("darwin", "arm64")?.assetName).toBe("codesurf-darwin-arm64");
    expect(getReleaseTargetForPlatform("darwin", "x64")?.assetName).toBe("codesurf-darwin-arm64");
    expect(getReleaseTargetForPlatform("linux", "x64")?.assetName).toBe("codesurf-linux-x64");
    expect(getReleaseTargetForPlatform("win32", "x64")?.assetName).toBe("codesurf-windows-x64.exe");
    expect(getReleaseTargetForPlatform("linux", "arm64")).toBeNull();
  });
});

describe("parseChecksumsFile", () => {
  it("parses standard and BSD-style checksum entries", () => {
    const checksums = parseChecksumsFile(
      [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  codesurf-darwin-arm64",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb *codesurf-windows-x64.exe",
      ].join("\n"),
    );
    expect(checksums.get("codesurf-darwin-arm64")).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(checksums.get("codesurf-windows-x64.exe")).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
  });
});

describe("script install metadata", () => {
  it("round-trips metadata through write and load", () => {
    const homeDir = createTempDir("grok-meta-");
    const installDir = getScriptInstallDir(homeDir);
    const metadata = {
      schemaVersion: 1,
      installMethod: "script" as const,
      version: "1.2.3",
      repo: "jasonkneen/codesurf-cli",
      binaryPath: path.join(installDir, "codesurf"),
      installDir,
      assetName: "codesurf-darwin-arm64",
      target: "darwin-arm64" as const,
      installedAt: "2026-04-03T00:00:00.000Z",
      shellConfigPath: path.join(homeDir, ".zshrc"),
      pathCommand: `export PATH=${installDir}:$PATH`,
    };

    saveScriptInstallMetadata(metadata, homeDir);
    expect(loadScriptInstallMetadata(homeDir)).toEqual(metadata);
    expect(fs.existsSync(getInstallMetadataPath(homeDir))).toBe(true);
  });

  it("returns null when no metadata file exists", () => {
    expect(loadScriptInstallMetadata(createTempDir("grok-empty-"))).toBeNull();
  });
});

describe("getScriptInstallContext", () => {
  it("returns context when metadata exists", () => {
    const homeDir = createTempDir("grok-ctx-");
    const installDir = getScriptInstallDir(homeDir);
    const currentTarget = getReleaseTargetForPlatform();
    expect(currentTarget).not.toBeNull();

    saveScriptInstallMetadata(
      {
        schemaVersion: 1,
        installMethod: "script" as const,
        version: "1.2.3",
        repo: "jasonkneen/codesurf-cli",
        binaryPath: path.join(installDir, currentTarget!.binaryName),
        installDir,
        assetName: currentTarget!.assetName,
        target: currentTarget!.key,
        installedAt: "2026-04-03T00:00:00.000Z",
      },
      homeDir,
    );

    const ctx = getScriptInstallContext(homeDir);
    expect(ctx?.metadata.installMethod).toBe("script");
    expect(ctx?.binaryPath).toBe(path.join(installDir, currentTarget!.binaryName));
  });

  it("returns null when no metadata exists", () => {
    expect(getScriptInstallContext(createTempDir("grok-no-ctx-"))).toBeNull();
  });
});

describe("buildScriptUninstallPlan", () => {
  it("removes the full ~/.codesurf directory by default", () => {
    const homeDir = createTempDir("codesurf-uninstall-");
    const installDir = getScriptInstallDir(homeDir);
    const currentTarget = getReleaseTargetForPlatform()!;
    fs.mkdirSync(installDir, { recursive: true });

    saveScriptInstallMetadata(
      {
        schemaVersion: 1,
        installMethod: "script" as const,
        version: "1.2.3",
        repo: "jasonkneen/codesurf-cli",
        binaryPath: path.join(installDir, currentTarget.binaryName),
        installDir,
        assetName: currentTarget.assetName,
        target: currentTarget.key,
        installedAt: "2026-04-03T00:00:00.000Z",
      },
      homeDir,
    );

    const plan = buildScriptUninstallPlan({}, homeDir);
    expect(plan?.removePaths).toContain(path.join(homeDir, ".codesurf"));
  });

  it("keeps config and data when requested", () => {
    const homeDir = createTempDir("codesurf-keep-");
    const installDir = getScriptInstallDir(homeDir);
    const currentTarget = getReleaseTargetForPlatform()!;
    fs.mkdirSync(installDir, { recursive: true });

    saveScriptInstallMetadata(
      {
        schemaVersion: 1,
        installMethod: "script" as const,
        version: "1.2.3",
        repo: "jasonkneen/codesurf-cli",
        binaryPath: path.join(installDir, currentTarget.binaryName),
        installDir,
        assetName: currentTarget.assetName,
        target: currentTarget.key,
        installedAt: "2026-04-03T00:00:00.000Z",
      },
      homeDir,
    );

    const plan = buildScriptUninstallPlan({ keepConfig: true, keepData: true }, homeDir);
    expect(plan?.removePaths).not.toContain(path.join(homeDir, ".codesurf"));
    expect(plan?.removePaths).toContain(path.join(installDir, currentTarget.binaryName));
  });
});

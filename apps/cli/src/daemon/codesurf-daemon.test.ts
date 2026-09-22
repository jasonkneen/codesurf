import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildDaemonScriptCandidates } from "./codesurf-daemon";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

describe("daemon script resolution", () => {
  const originalCwd = process.cwd();
  let tempDir: string | undefined;

  afterEach(() => {
    process.chdir(originalCwd);
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("never resolves the daemon from the current working directory", () => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-daemon-cwd-")));
    for (const rel of ["bin", "dist/bin", "node_modules/@codesurf/daemon/bin"]) {
      fs.mkdirSync(path.join(tempDir, rel), { recursive: true });
      fs.writeFileSync(path.join(tempDir, rel, "codesurfd.mjs"), "process.exit(0)");
    }
    process.chdir(tempDir);

    const candidates = buildDaemonScriptCandidates(moduleDir, "/usr/local/bin/node", () => {
      throw new Error("not installed");
    });

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(path.resolve(candidate).startsWith(tempDir)).toBe(false);
    }
  });

  it("prefers the wrapper shipped with this install, then the installed package", () => {
    const candidates = buildDaemonScriptCandidates(moduleDir, "/usr/local/bin/node", () => "/pkg/package.json");
    expect(candidates[0]).toBe(path.join(moduleDir, "..", "..", "bin", "codesurfd.mjs"));
    expect(candidates[1]).toBe(path.join("/pkg", "bin", "codesurfd.mjs"));
  });
});

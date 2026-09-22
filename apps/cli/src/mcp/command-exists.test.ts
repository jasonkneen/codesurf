import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commandExists, resolveCommandPath } from "./command-exists";

describe("commandExists", () => {
  it("returns true for a binary that is guaranteed to exist on the runtime", () => {
    // node is the runtime — if this fails, the test environment is broken.
    expect(commandExists("node")).toBe(true);
  });

  it("returns false for a command that cannot resolve on PATH", () => {
    expect(commandExists("definitely-not-a-real-command-xyz-12345")).toBe(false);
  });

  it("returns false for an empty or whitespace-only command", () => {
    expect(commandExists("")).toBe(false);
    expect(commandExists("   ")).toBe(false);
  });
});

describe("commandExists with a configured spawn context", () => {
  const isWindows = process.platform === "win32";
  const executableName = isWindows ? "codesurf-fixture-server.cmd" : "codesurf-fixture-server";
  let fixtureDir: string;
  let binDir: string;

  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "codesurf-command-exists-"));
    binDir = join(fixtureDir, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, executableName), isWindows ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(binDir, "codesurf-fixture-notes.txt"), "not an executable", { mode: 0o644 });
    mkdirSync(join(binDir, "codesurf-fixture-dir"));
  });

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("resolves a cwd-relative command against the configured cwd, not the host cwd", () => {
    expect(commandExists(`./bin/${executableName}`, { cwd: fixtureDir })).toBe(true);
    expect(resolveCommandPath(`bin/${executableName}`, { cwd: fixtureDir })).toBe(join(binDir, executableName));
    expect(commandExists(`./bin/${executableName}`)).toBe(false);
  });

  it("searches the configured env PATH instead of the host PATH", () => {
    const env = { PATH: binDir };
    expect(commandExists("codesurf-fixture-server", { env })).toBe(true);
    expect(resolveCommandPath("codesurf-fixture-server", { env })).toBe(join(binDir, executableName));
    expect(commandExists("codesurf-fixture-server")).toBe(false);
    // A configured PATH replaces the host PATH, so host binaries stop resolving.
    expect(commandExists("node", { env })).toBe(false);
  });

  it("resolves relative PATH entries against the configured cwd", () => {
    expect(commandExists("codesurf-fixture-server", { cwd: fixtureDir, env: { PATH: "bin" } })).toBe(true);
    expect(commandExists("codesurf-fixture-server", { env: { PATH: "bin" } })).toBe(false);
  });

  it("does not treat directories as executables", () => {
    expect(commandExists("codesurf-fixture-dir", { env: { PATH: binDir } })).toBe(false);
    expect(commandExists("./bin/codesurf-fixture-dir", { cwd: fixtureDir })).toBe(false);
  });

  it.skipIf(isWindows)("does not treat non-executable files as executables", () => {
    expect(commandExists("codesurf-fixture-notes.txt", { env: { PATH: binDir } })).toBe(false);
    expect(commandExists("./bin/codesurf-fixture-notes.txt", { cwd: fixtureDir })).toBe(false);
  });
});

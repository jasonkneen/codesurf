import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLspCacheRoot, lspNpmWhich } from "./npm-cache";

// Every test owns a throwaway config directory; the cache root is resolved
// through the shared CODESURF_CONFIG_DIR override so nothing under the real
// home directory is read, written or removed.
const originalConfigDir = process.env.CODESURF_CONFIG_DIR;
const originalLegacyConfigDir = process.env.GROK_CONFIG_DIR;
let configDir = "";

beforeEach(async () => {
  configDir = await mkdtemp(path.join(os.tmpdir(), "codesurf-lsp-npm-cache-"));
  process.env.CODESURF_CONFIG_DIR = configDir;
  delete process.env.GROK_CONFIG_DIR;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
  if (originalLegacyConfigDir === undefined) delete process.env.GROK_CONFIG_DIR;
  else process.env.GROK_CONFIG_DIR = originalLegacyConfigDir;
  await rm(configDir, { recursive: true, force: true });
});

describe("getLspCacheRoot", () => {
  it("lives under the configured config directory", () => {
    expect(getLspCacheRoot()).toBe(path.join(configDir, "cache", "lsp"));
  });

  it("falls back to the legacy ~/.grok cache when nothing is configured", () => {
    delete process.env.CODESURF_CONFIG_DIR;
    expect(getLspCacheRoot()).toBe(path.join(os.homedir(), ".grok", "cache", "lsp"));
  });
});

describe("lspNpmWhich", () => {
  it("resolves a single binary from a pre-populated cache", async () => {
    const dir = await createFakePackageCache("fake-server", { "fake-server": "lib/cli.js" });
    const result = await lspNpmWhich("fake-server");

    expect(dir.startsWith(configDir)).toBe(true);
    expect(result).toBe(path.join(dir, "node_modules", ".bin", "fake-server"));
  });

  it("resolves the correct binary from a multi-binary package", async () => {
    const dir = await createFakePackageCache("multi-bin", {
      "multi-bin": "lib/main.js",
      "multi-bin-helper": "lib/helper.js",
    });
    const result = await lspNpmWhich("multi-bin");

    expect(result).toBe(path.join(dir, "node_modules", ".bin", "multi-bin"));
  });

  it("returns null when the package cannot be installed", async () => {
    const result = await lspNpmWhich("@nonexistent-scope/totally-fake-package-that-does-not-exist-12345");
    expect(result).toBeNull();
  });
});

async function createFakePackageCache(pkg: string, binEntries: Record<string, string>): Promise<string> {
  const cacheRoot = path.join(getLspCacheRoot(), pkg);

  const binDir = path.join(cacheRoot, "node_modules", ".bin");
  const pkgDir = path.join(cacheRoot, "node_modules", pkg);
  await mkdir(binDir, { recursive: true });
  await mkdir(pkgDir, { recursive: true });

  for (const [name, target] of Object.entries(binEntries)) {
    const targetPath = path.join(pkgDir, target);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, "#!/usr/bin/env node\n", { mode: 0o755 });

    const linkPath = path.join(binDir, name);
    await symlink(path.relative(binDir, targetPath), linkPath).catch(() => {
      // Fallback: write a stub file if symlinks fail (Windows)
      return writeFile(linkPath, `#!/bin/sh\nnode "${targetPath}" "$@"\n`, { mode: 0o755 });
    });
  }

  await writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: pkg,
      bin: Object.keys(binEntries).length === 1 ? Object.values(binEntries)[0] : binEntries,
    }),
  );

  return cacheRoot;
}

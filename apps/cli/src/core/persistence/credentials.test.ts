import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCredential, loadCredential, resolveApiKey, saveCredential } from "./credentials";

let tempDir: string;
let originalConfigDir: string | undefined;

function credentialsFilePath(): string {
  return path.join(tempDir, "credentials.json");
}

function corruptBackupNames(): string[] {
  return fs
    .readdirSync(tempDir)
    .filter((entry) => entry.startsWith("credentials.json.corrupt-"))
    .sort();
}

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-creds-test-"));
  originalConfigDir = process.env.CODESURF_CONFIG_DIR;
  process.env.CODESURF_CONFIG_DIR = tempDir;
});

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  for (const entry of fs.readdirSync(tempDir)) {
    if (entry.startsWith("credentials.json")) fs.unlinkSync(path.join(tempDir, entry));
  }
  delete process.env.TEST_ADAPTER_KEY;
});

afterEach(() => {
  delete process.env.TEST_ADAPTER_KEY;
});

describe("credentials persistence", () => {
  it("round-trips an API-key credential through the file", () => {
    saveCredential("test.adapter", { type: "api-key", value: "sk-xxx" });
    expect(loadCredential("test.adapter")).toEqual({
      type: "api-key",
      value: "sk-xxx",
    });
  });

  it("round-trips an OAuth credential", () => {
    saveCredential("test.adapter", {
      type: "oauth",
      token: "t-123",
      refreshToken: "r-456",
      expiresAt: "2030-01-01T00:00:00Z",
      scope: "read write",
    });
    const loaded = loadCredential("test.adapter");
    expect(loaded).toMatchObject({
      type: "oauth",
      token: "t-123",
      refreshToken: "r-456",
      expiresAt: "2030-01-01T00:00:00Z",
      scope: "read write",
    });
  });

  it("removes an entry with clearCredential()", () => {
    saveCredential("test.adapter", { type: "api-key", value: "sk-yyy" });
    clearCredential("test.adapter");
    expect(loadCredential("test.adapter")).toBeNull();
  });

  it("writes the file with mode 0600 on POSIX", () => {
    if (process.platform === "win32") return;
    saveCredential("test.adapter", { type: "api-key", value: "sk-zzz" });
    const credsFile = path.join(tempDir, "credentials.json");
    const stat = fs.statSync(credsFile);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("replaces the file atomically, owner-only from creation", () => {
    if (process.platform === "win32") return;
    saveCredential("test.adapter", { type: "api-key", value: "sk-1" });
    const credsFile = credentialsFilePath();
    fs.chmodSync(credsFile, 0o644);
    const inodeBefore = fs.statSync(credsFile).ino;

    saveCredential("test.adapter", { type: "api-key", value: "sk-2" });

    const stat = fs.statSync(credsFile);
    // Renamed into place rather than truncated and rewritten.
    expect(stat.ino).not.toBe(inodeBefore);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(loadCredential("test.adapter")).toEqual({ type: "api-key", value: "sk-2" });
    expect(fs.readdirSync(tempDir).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("does not overwrite a corrupt credentials file during a write", () => {
    const credsFile = credentialsFilePath();
    const corruptContents = '{"test.adapter":{"type":"api-key","value":"existing"}';
    fs.writeFileSync(credsFile, corruptContents, "utf-8");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() => saveCredential("new.adapter", { type: "api-key", value: "new" })).toThrow(
        /Refusing to continue so stored credentials are not overwritten/,
      );
      expect(fs.readFileSync(credsFile, "utf-8")).toBe(corruptContents);

      expect(() => saveCredential("new.adapter", { type: "api-key", value: "new" })).toThrow(
        /Refusing to continue so stored credentials are not overwritten/,
      );
      expect(fs.readFileSync(credsFile, "utf-8")).toBe(corruptContents);

      const backups = corruptBackupNames();
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(path.join(tempDir, backups[0]), "utf-8")).toBe(corruptContents);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("Failed to read credentials file"));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("uses env-var auth when the credentials file is corrupt", () => {
    fs.writeFileSync(credentialsFilePath(), '{"test.adapter":', "utf-8");
    process.env.TEST_ADAPTER_KEY = "from-env";

    expect(resolveApiKey("test.adapter", "TEST_ADAPTER_KEY")).toBe("from-env");
    expect(corruptBackupNames()).toHaveLength(0);
  });

  it("does not throw or create backups during repeated reads of a corrupt credentials file", () => {
    fs.writeFileSync(credentialsFilePath(), '{"test.adapter":', "utf-8");

    expect(loadCredential("test.adapter")).toBeNull();
    expect(loadCredential("test.adapter")).toBeNull();
    expect(resolveApiKey("test.adapter", "TEST_ADAPTER_KEY")).toBeNull();
    expect(corruptBackupNames()).toHaveLength(0);
  });

  it("prefers the env var over the persisted file", () => {
    saveCredential("test.adapter", { type: "api-key", value: "from-file" });
    process.env.TEST_ADAPTER_KEY = "from-env";
    expect(resolveApiKey("test.adapter", "TEST_ADAPTER_KEY")).toBe("from-env");
  });

  it("falls back to the persisted file when the env var is absent", () => {
    saveCredential("test.adapter", { type: "api-key", value: "from-file" });
    expect(resolveApiKey("test.adapter", "TEST_ADAPTER_KEY")).toBe("from-file");
  });

  it("returns null when neither env var nor file has a value", () => {
    expect(resolveApiKey("test.adapter", "TEST_ADAPTER_KEY")).toBeNull();
  });

  it("ignores an empty string in the env var and falls back to the file", () => {
    saveCredential("test.adapter", { type: "api-key", value: "from-file" });
    process.env.TEST_ADAPTER_KEY = "   ";
    expect(resolveApiKey("test.adapter", "TEST_ADAPTER_KEY")).toBe("from-file");
  });
});

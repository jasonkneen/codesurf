import type { PathLike } from "fs";
import { existsSync } from "fs";
import { type FileHandle, mkdir, mkdtemp, readFile, rm, symlink, writeFile as writeFsFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyWritePath,
  computeEditPreview,
  editFile,
  readFile as readToolFile,
  writeFile,
  writePathRequiresApproval,
} from "./file";

// Seam for the mid-scan cancellation test: observe every FileHandle.read call
// issued through fs/promises.open without touching the tool's public surface.
const readHook = vi.hoisted(() => ({
  onRead: null as null | ((call: number) => void),
  calls: 0,
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    open: async (file: PathLike, flags?: string | number, mode?: string | number): Promise<FileHandle> => {
      const handle = await actual.open(file, flags, mode);
      if (!readHook.onRead) return handle;
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === "read") {
            return (...args: Parameters<FileHandle["read"]>) => {
              readHook.calls++;
              readHook.onRead?.(readHook.calls);
              return (
                target.read as (...inner: Parameters<FileHandle["read"]>) => ReturnType<FileHandle["read"]>
              ).apply(target, args);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

const summarizeDiagnosticsMock = vi.fn<(diagnostics: unknown) => string>(() => "1 LSP issue · 1 error");
const syncFileWithLspMock = vi.fn<
  (
    cwd: string,
    filePath: string,
    content: string,
    save: boolean,
    waitForDiagnostics: boolean,
  ) => Promise<
    Array<{
      filePath: string;
      serverId: string;
      diagnostics: Array<{
        message: string;
        severity: number;
        range: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
      }>;
    }>
  >
>(async () => [
  {
    filePath: "/tmp/demo.ts",
    serverId: "typescript",
    diagnostics: [
      {
        message: "Type error",
        severity: 1,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
      },
    ],
  },
]);

vi.mock("../lsp/runtime", () => ({
  summarizeDiagnostics: (diagnostics: unknown) => summarizeDiagnosticsMock(diagnostics),
  syncFileWithLsp: (cwd: string, filePath: string, content: string, save: boolean, waitForDiagnostics: boolean) =>
    syncFileWithLspMock(cwd, filePath, content, save, waitForDiagnostics),
}));

const tempDirs: string[] = [];

afterEach(async () => {
  summarizeDiagnosticsMock.mockClear();
  syncFileWithLspMock.mockClear();
  readHook.onRead = null;
  readHook.calls = 0;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("file tool LSP integration", () => {
  it("includes diagnostics metadata when writing a file", async () => {
    const cwd = await createTempDir();
    const result = await writeFile("demo.ts", "const answer = 42;\n", cwd);

    expect(result.success).toBe(true);
    expect(result.output).toContain("1 LSP issue");
    expect(result.lspDiagnostics).toHaveLength(1);
    expect(syncFileWithLspMock).toHaveBeenCalledWith(
      cwd,
      path.join(cwd, "demo.ts"),
      "const answer = 42;\n",
      true,
      true,
    );
  });

  it("syncs edited file contents through the LSP runtime", async () => {
    const cwd = await createTempDir();
    const filePath = path.join(cwd, "demo.ts");
    await writeFsFile(filePath, "const answer = 41;\n", "utf8");

    const result = await editFile("demo.ts", "41", "42", cwd);
    const content = await readFile(filePath, "utf8");

    expect(result.success).toBe(true);
    expect(content).toContain("42");
    expect(syncFileWithLspMock).toHaveBeenCalledWith(cwd, filePath, "const answer = 42;\n", true, true);
  });

  it("replaces oldString with literal special-dollar text and preserves exact UTF-8 bytes", async () => {
    const cwd = await createTempDir();
    const filePath = path.join(cwd, "demo.ts");
    await writeFsFile(filePath, "start TOKEN end", "utf8");

    const newString = "literal-$&-$$-$`-$'-café-漢";
    const preview = computeEditPreview(
      "edit_file",
      { path: "demo.ts", old_string: "TOKEN", new_string: newString },
      cwd,
    );
    expect(preview).not.toBeNull();
    expect(preview?.patch).toContain("start literal-$&-$$-$`-$'-café-漢 end");

    const result = await editFile("demo.ts", "TOKEN", newString, cwd);
    const written = await readFile(filePath, "utf8");

    expect(result.success).toBe(true);
    expect(Buffer.from(written, "utf8")).toEqual(Buffer.from("start literal-$&-$$-$`-$'-café-漢 end", "utf8"));
  });

  it("does not write when oldString is empty and preview returns null", async () => {
    const cwd = await createTempDir();
    const filePath = path.join(cwd, "demo.ts");
    await writeFsFile(filePath, "start TOKEN end", "utf8");

    const result = await editFile("demo.ts", "", "replacement", cwd);
    const preview = computeEditPreview(
      "edit_file",
      { path: "demo.ts", old_string: "", new_string: "replacement" },
      cwd,
    );
    const written = await readFile(filePath, "utf8");

    expect(result.success).toBe(false);
    expect(result.output).toContain("old_string must be non-empty");
    expect(preview).toBeNull();
    expect(written).toBe("start TOKEN end");
  });
});

describe("readFile output limits", () => {
  const CHUNK = 64 * 1024;

  function bodyLines(output: string): string[] {
    return output.split("\n").slice(1);
  }

  it("reports the exact total when the whole file was scanned", async () => {
    const cwd = await createTempDir();
    await writeFsFile(
      path.join(cwd, "ten.txt"),
      `${Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")}\n`,
    );

    const result = await readToolFile("ten.txt", cwd);

    expect(result.success).toBe(true);
    expect(result.output.split("\n")[0]).toBe("[ten.txt: lines 1-10 of 10]");
    expect(bodyLines(result.output)).toHaveLength(10);
    expect(bodyLines(result.output)[9]).toBe("10 | line 10");
  });

  it("bounds output for a very large single line", async () => {
    const cwd = await createTempDir();
    const hugeLine = "x".repeat(5 * 1024 * 1024);
    await writeFsFile(path.join(cwd, "wide.txt"), `${hugeLine}\ntail\n`);

    const result = await readToolFile("wide.txt", cwd);

    expect(result.success).toBe(true);
    expect(result.output.length).toBeLessThan(2_200);
    expect(result.output.split("\n")[0]).toBe("[wide.txt: lines 1-2 of 2]");
    const [first, second] = bodyLines(result.output);
    expect(first).toBe(`1 | ${"x".repeat(2000)}...`);
    expect(second).toBe("2 | tail");
  });

  it("stops at 2,000 output lines and says the file continues without claiming a total", async () => {
    const cwd = await createTempDir();
    await writeFsFile(
      path.join(cwd, "many.txt"),
      `${Array.from({ length: 3000 }, (_, i) => `l${i + 1}`).join("\n")}\n`,
    );

    const result = await readToolFile("many.txt", cwd);

    expect(result.success).toBe(true);
    expect(result.output.split("\n")[0]).toBe(
      "[many.txt: lines 1-2000; output limit reached, file continues (total not counted; continue with start_line=2001)]",
    );
    expect(bodyLines(result.output)).toHaveLength(2000);
    expect(bodyLines(result.output)[1999]).toBe("2000 | l2000");
    expect(result.output).not.toContain("of 3000");
  });

  it("reports exactly 2,000 lines as complete", async () => {
    const cwd = await createTempDir();
    await writeFsFile(
      path.join(cwd, "exact.txt"),
      `${Array.from({ length: 2000 }, (_, i) => `l${i + 1}`).join("\n")}\n`,
    );

    const result = await readToolFile("exact.txt", cwd);

    expect(result.output.split("\n")[0]).toBe("[exact.txt: lines 1-2000 of 2000]");
    expect(bodyLines(result.output)).toHaveLength(2000);
  });

  it("labels an early range honestly and does not scan the rest of the file", async () => {
    const cwd = await createTempDir();
    await writeFsFile(
      path.join(cwd, "hundred.txt"),
      `${Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")}\n`,
    );

    const result = await readToolFile("hundred.txt", cwd, 5, 10);

    expect(result.success).toBe(true);
    expect(result.output.split("\n")[0]).toBe(
      "[hundred.txt: lines 5-10; file continues (total not counted; continue with start_line=11)]",
    );
    expect(bodyLines(result.output)).toEqual([
      "5 | line 5",
      "6 | line 6",
      "7 | line 7",
      "8 | line 8",
      "9 | line 9",
      "10 | line 10",
    ]);
  });

  it("reports an exact total when the requested range ends at the last line", async () => {
    const cwd = await createTempDir();
    await writeFsFile(path.join(cwd, "short.txt"), "a\nb\nc\n");

    const result = await readToolFile("short.txt", cwd, 2, 3);

    expect(result.output.split("\n")[0]).toBe("[short.txt: lines 2-3 of 3]");
  });

  it("decodes a multi-byte character split across the chunk boundary", async () => {
    const cwd = await createTempDir();
    // Each line is 3 bytes ("é\n"); the 64 KiB boundary falls between the two bytes of an é.
    const lineCount = 30_000;
    await writeFsFile(path.join(cwd, "accents.txt"), "é\n".repeat(lineCount));
    const boundaryLine = Math.floor(CHUNK / 3) + 1;
    expect(CHUNK % 3).toBe(1);

    const result = await readToolFile("accents.txt", cwd, boundaryLine - 2, boundaryLine + 2);

    expect(result.success).toBe(true);
    expect(result.output).not.toContain("\uFFFD");
    expect(bodyLines(result.output)).toEqual([
      `${boundaryLine - 2} | é`,
      `${boundaryLine - 1} | é`,
      `${boundaryLine} | é`,
      `${boundaryLine + 1} | é`,
      `${boundaryLine + 2} | é`,
    ]);
  });

  it("handles an empty file and a start line beyond the end without inventing a range", async () => {
    const cwd = await createTempDir();
    await writeFsFile(path.join(cwd, "empty.txt"), "");
    await writeFsFile(path.join(cwd, "ten.txt"), `${Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n")}\n`);

    const empty = await readToolFile("empty.txt", cwd);
    const beyond = await readToolFile("ten.txt", cwd, 50);

    expect(empty).toEqual({ success: true, output: "[empty.txt: no lines in range 1-end; file has 0 lines]" });
    expect(beyond).toEqual({ success: true, output: "[ten.txt: no lines in range 50-end; file has 10 lines]" });
  });

  it("returns a cancelled result without opening the file when the signal is already aborted", async () => {
    const cwd = await createTempDir();
    await writeFsFile(path.join(cwd, "a.txt"), "hello\n");
    const controller = new AbortController();
    controller.abort();
    readHook.onRead = () => {};

    const result = await readToolFile("a.txt", cwd, undefined, undefined, { signal: controller.signal });

    expect(result).toEqual({ success: false, output: "Read cancelled: a.txt" });
    expect(readHook.calls).toBe(0);
  });

  it("stops scanning when cancelled between chunk reads", async () => {
    const cwd = await createTempDir();
    // 1,000 lines x 300 chars ≈ 300 KB: five chunks, well under the 2,000-line cap.
    await writeFsFile(path.join(cwd, "big.txt"), `${"y".repeat(299)}\n`.repeat(1000));
    const controller = new AbortController();
    readHook.onRead = (call) => {
      if (call === 2) controller.abort();
    };

    const result = await readToolFile("big.txt", cwd, undefined, undefined, { signal: controller.signal });

    expect(result).toEqual({ success: false, output: "Read cancelled: big.txt" });
    expect(readHook.calls).toBe(2);
  });
});

describe("file tool write-path policy", () => {
  it("refuses writes outside the workspace in sandbox mode", async () => {
    const cwd = await createTempDir();
    const outside = await createTempDir();
    const target = path.join(outside, "escape.txt");

    const result = await writeFile(target, "x", cwd, { sandboxMode: "shuru" });

    expect(result.success).toBe(false);
    expect(result.output).toContain("sandbox mode only allows file writes inside the workspace");
    expect(existsSync(target)).toBe(false);
  });

  it("refuses a sandboxed write through a workspace symlink that points outside", async () => {
    const cwd = await createTempDir();
    const outside = await createTempDir();
    await symlink(outside, path.join(cwd, "link"));
    await writeFsFile(path.join(outside, "victim.txt"), "original");

    const write = await writeFile("link/new.txt", "x", cwd, { sandboxMode: "shuru" });
    const edit = await editFile("link/victim.txt", "original", "changed", cwd, { sandboxMode: "shuru" });

    expect(write.success).toBe(false);
    expect(edit.success).toBe(false);
    expect(existsSync(path.join(outside, "new.txt"))).toBe(false);
    expect(await readFile(path.join(outside, "victim.txt"), "utf8")).toBe("original");
  });

  it("still allows sandboxed writes inside the workspace", async () => {
    const cwd = await createTempDir();
    const result = await writeFile("src/ok.txt", "x", cwd, { sandboxMode: "shuru" });
    expect(result.success).toBe(true);
  });

  it("refuses writes to CodeSurf's own config in every mode", async () => {
    const cwd = await createTempDir();
    const configDir = await createTempDir();
    const prev = process.env.CODESURF_CONFIG_DIR;
    process.env.CODESURF_CONFIG_DIR = configDir;
    try {
      const target = path.join(configDir, "user-settings.json");
      const result = await writeFile(target, '{"hooks":{}}', cwd, { sandboxMode: "off" });
      expect(result.success).toBe(false);
      expect(result.output).toContain("CodeSurf configuration files");
      expect(existsSync(target)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CODESURF_CONFIG_DIR;
      else process.env.CODESURF_CONFIG_DIR = prev;
    }
  });

  it("protects the settings files even when the workspace is inside the config dir", async () => {
    const configDir = await createTempDir();
    const cwd = path.join(configDir, "extensions", "mine");
    await mkdir(cwd, { recursive: true });
    const prev = process.env.CODESURF_CONFIG_DIR;
    process.env.CODESURF_CONFIG_DIR = configDir;
    try {
      const settings = await writeFile(path.join(configDir, "user-settings.json"), "{}", cwd, { sandboxMode: "off" });
      const trust = await writeFile(path.join(configDir, "workspace-trust.json"), "{}", cwd, { sandboxMode: "off" });
      const own = await writeFile("main.js", "x", cwd, { sandboxMode: "off" });
      expect(settings.success).toBe(false);
      expect(trust.success).toBe(false);
      expect(own.success).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CODESURF_CONFIG_DIR;
      else process.env.CODESURF_CONFIG_DIR = prev;
    }
  });

  it("classifies shell rc files and out-of-workspace paths as needing approval", async () => {
    const home = await createTempDir();
    const cwd = path.join(home, "project");
    await mkdir(cwd);

    expect(classifyWritePath(path.join(home, ".zshrc"), home, home)).toBe("shell-rc");
    expect(classifyWritePath(path.join(cwd, "a.ts"), cwd, home)).toBe("workspace");
    expect(classifyWritePath(path.join(home, "elsewhere.txt"), cwd, home)).toBe("outside");
    expect(writePathRequiresApproval(path.join(cwd, "a.ts"), cwd)).toBe(false);
    expect(writePathRequiresApproval(path.join(home, "elsewhere.txt"), cwd)).toBe(true);
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grok-file-tools-"));
  tempDirs.push(dir);
  return dir;
}

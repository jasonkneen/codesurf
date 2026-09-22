import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFileNavigatorData } from "./files-command";

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("buildFileNavigatorData", () => {
  it("opens a file at the requested initial line", () => {
    tempDir = mkdtempSync(join(tmpdir(), "codesurf-files-command-"));
    const file = join(tempDir, "app.ts");
    writeFileSync(file, ["one", "two", "three"].join("\n"));

    expect(buildFileNavigatorData(file, tempDir, { initialLine: 2 })).toEqual(
      expect.objectContaining({
        path: file,
        currentLine: 2,
        lines: ["one", "two", "three"],
      }),
    );
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractExistingLocalFilePaths, normalizeLocalPathText } from "./local-file-paths";

describe("local file path helpers", () => {
  it("normalizes shell-escaped screenshot paths", () => {
    expect(normalizeLocalPathText("/tmp/Screenshot\\ 2026-06-08\\ at\\ 07.41.51.png")).toBe(
      "/tmp/Screenshot 2026-06-08 at 07.41.51.png",
    );
  });

  it("extracts only existing local file paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "codesurf-paths-"));
    try {
      const image = join(dir, "Screenshot 2026-06-08 at 07.41.51.png");
      writeFileSync(image, "png");

      expect(extractExistingLocalFilePaths(`${image.replace(/ /g, "\\ ")} /tmp/missing.png`)).toEqual([image]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

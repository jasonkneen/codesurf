import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("InlineImage overlay suppression", () => {
  it("clears terminal-native image placements while overlays are open", () => {
    const source = readFileSync(fileURLToPath(new URL("./inline-image.tsx", import.meta.url)), "utf8");

    expect(source).toContain("let inlineImageSuppressed = false;");
    expect(source).toContain("export function setInlineImageSuppressed(suppressed: boolean): void");
    expect(source).toContain("if (inlineImageSuppressed || !seen || !pos) {");
    expect(source).toContain("clearPlacement();");
    expect(source).toContain("if (inlineImageSuppressed) return;");
  });
});

describe("InlineImage height reservation + path helpers", () => {
  const source = readFileSync(fileURLToPath(new URL("./inline-image.tsx", import.meta.url)), "utf8");

  it("reserves the decoded cell-height once ready (kills the wide-short gap)", () => {
    // Both ready branches reserve the real decoded height, not the max slot.
    expect((source.match(/height=\{image\.cellHeight\}/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // …and the decoded height is cached for the virtualizer estimator.
    expect(source).toContain("cellHeightBySrc.set(normalizedSrc, image.cellHeight);");
  });

  it("exposes the estimator + strip helpers the transcript renderer needs", () => {
    expect(source).toContain("export function estimateInlineImageRows(");
    expect(source).toContain('export { extractImagePaths, stripImagePaths } from "./image-paths";');
  });
});

describe("InlineImage kitty placement", () => {
  const source = readFileSync(fileURLToPath(new URL("./inline-image.tsx", import.meta.url)), "utf8");

  it("does not keep the renderer live while an image is merely mounted", () => {
    expect(source).not.toContain("renderer.requestLive()");
    expect(source).toContain("renderer.addPostProcessFn(place);");
    expect(source).toContain("renderer.removePostProcessFn(place);");
  });

  it("moves and scroll-outs delete only the placement, keeping the image data", () => {
    expect(source).toContain("process.stdout.write(kittyDelete(imageId, { keepData: true }));");
    // Only unmount frees the data (a single bare kittyDelete call).
    expect(source.match(/kittyDelete\(imageId\)/g)?.length).toBe(1);
  });

  it("keys the resize cache on source mtime/size and prunes it", () => {
    expect(source).toContain("inlineImageCacheKey(src, statSync(src),");
    expect(source).toContain("pruneInlineImageCache(CACHE_ROOT);");
  });
});

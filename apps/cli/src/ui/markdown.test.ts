import { describe, expect, it } from "vitest";
import { parseLocalFileLinkSegments, planMarkdownRenderBlocks } from "./markdown";
import { localFileLinkTargetFromHref, normalizeMarkdownLocalFileLinks } from "./markdown-links";

describe("normalizeMarkdownLocalFileLinks", () => {
  it("turns shell-escaped local screenshot paths into file links", () => {
    const input =
      "/var/folders/2p/sxcyllnn2ds9dlyqt78jd8nm0000gn/T/TemporaryItems/NSIRD_screencaptureui_juDfR1/Screenshot\\ 2026-06-08\\ at\\ 00.45.16.png";

    expect(normalizeMarkdownLocalFileLinks(input)).toBe(
      "[/var/folders/2p/sxcyllnn2ds9dlyqt78jd8nm0000gn/T/TemporaryItems/NSIRD_screencaptureui_juDfR1/Screenshot 2026-06-08 at 00.45.16.png](<file:///var/folders/2p/sxcyllnn2ds9dlyqt78jd8nm0000gn/T/TemporaryItems/NSIRD_screencaptureui_juDfR1/Screenshot%202026-06-08%20at%2000.45.16.png>)",
    );
  });

  it("normalizes absolute markdown link destinations to file URLs", () => {
    const input = "[screenshot](/tmp/Screenshot\\ 2026-06-08\\ at\\ 00.45.16.png)";

    expect(normalizeMarkdownLocalFileLinks(input)).toBe(
      "[screenshot](<file:///tmp/Screenshot%202026-06-08%20at%2000.45.16.png>)",
    );
  });

  it("preserves line suffixes as file URL fragments", () => {
    expect(normalizeMarkdownLocalFileLinks("[app](/tmp/app.ts:12)")).toBe("[app](<file:///tmp/app.ts#L12>)");
  });

  it("preserves bare path line suffixes as file URL fragments", () => {
    expect(normalizeMarkdownLocalFileLinks("Open /tmp/app.ts:12")).toBe(
      "Open [/tmp/app.ts:12](<file:///tmp/app.ts#L12>)",
    );
  });

  it("decodes file links into file-viewer targets", () => {
    expect(localFileLinkTargetFromHref("file:///tmp/app.ts#L12")).toEqual({
      href: "file:///tmp/app.ts#L12",
      path: "/tmp/app.ts",
      line: 12,
    });
  });

  it("decodes the web /files href the live front uses", () => {
    const href = "http://127.0.0.1:3948/files?path=%2Ftmp%2Fapp.ts#L12";
    expect(localFileLinkTargetFromHref(href)).toEqual({
      href,
      path: "/tmp/app.ts",
      line: 12,
    });
  });

  it("extracts clickable local file link segments", () => {
    const segments = parseLocalFileLinkSegments("Open [app](<file:///tmp/app.ts#L12>) now");

    expect(segments?.[0]).toEqual([
      { text: "Open " },
      { text: "app", target: { href: "file:///tmp/app.ts#L12", path: "/tmp/app.ts", line: 12 } },
      { text: " now" },
    ]);
  });

  it("does not rewrite inline code or fenced code examples", () => {
    const input = ["`/tmp/Screenshot\\ 2026-06-08.png`", "```", "/tmp/Screenshot\\ 2026-06-08.png", "```"].join("\n");

    expect(normalizeMarkdownLocalFileLinks(input)).toBe(input);
  });
});

describe("planMarkdownRenderBlocks", () => {
  it("keeps markdown rendering for the rest of a message that mentions a local path", () => {
    const content = normalizeMarkdownLocalFileLinks(
      ["## Summary", "", "- **fixed** the bug", "", "See /tmp/app.ts for details.", "", "```ts", "", "x", "```"].join(
        "\n",
      ),
    );
    const blocks = planMarkdownRenderBlocks(content);

    expect(blocks?.map((b) => b.kind)).toEqual(["markdown", "links", "markdown"]);
    expect(blocks?.[0]).toEqual({ kind: "markdown", content: "## Summary\n\n- **fixed** the bug" });
    expect(blocks?.[2]).toEqual({ kind: "markdown", content: "```ts\n\nx\n```" });
    const links = blocks?.[1];
    expect(links?.kind === "links" && links.lines[0].find((seg) => seg.target)?.target?.path).toBe("/tmp/app.ts");
  });

  it("renders a paragraph with other markdown syntax as markdown even if it has a path", () => {
    const content = normalizeMarkdownLocalFileLinks("Edited **carefully**: /tmp/app.ts");
    expect(planMarkdownRenderBlocks(content)).toBeNull();
  });

  it("returns null when nothing links to a local file", () => {
    expect(planMarkdownRenderBlocks("# Title\n\nplain text")).toBeNull();
  });
});

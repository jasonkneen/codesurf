import { describe, expect, it } from "vitest";
import { extractImagePaths, stripImagePaths } from "./image-paths";

describe("extractImagePaths", () => {
  it("matches whole absolute path tokens", () => {
    expect(extractImagePaths("see /tmp/shot.png now")).toEqual(["/tmp/shot.png"]);
    expect(extractImagePaths("/tmp/a.jpg")).toEqual(["/tmp/a.jpg"]);
  });

  it("does not span spaces between an unrelated path and an image name", () => {
    expect(extractImagePaths("files in /tmp/dir and also logo.png")).toEqual([]);
  });

  it("does not match mid-word or relative paths", () => {
    expect(extractImagePaths("docs/img/logo.png")).toEqual([]);
    expect(extractImagePaths("prefix/tmp/logo.png")).toEqual([]);
  });

  it("does not match http(s) URLs (never sent to sharp)", () => {
    expect(extractImagePaths("https://example.com/a.png")).toEqual([]);
    expect(extractImagePaths("look http://x.io/b.jpg")).toEqual([]);
  });

  it("accepts spaces when quoted or shell-escaped", () => {
    expect(extractImagePaths('open "/tmp/My Shot.png"')).toEqual(["/tmp/My Shot.png"]);
    expect(extractImagePaths("/tmp/Screenshot\\ 2026.png")).toEqual(["/tmp/Screenshot 2026.png"]);
  });
});

describe("stripImagePaths", () => {
  it("removes only the image path token", () => {
    expect(stripImagePaths("look at /tmp/a.png please")).toBe("look at please");
    expect(stripImagePaths("/tmp/a.png")).toBe("");
  });

  it("leaves user text that is not a whole image path untouched", () => {
    const text = "compare /usr/bin and the screenshot.png in docs/x.png";
    expect(stripImagePaths(text)).toBe(text);
  });
});

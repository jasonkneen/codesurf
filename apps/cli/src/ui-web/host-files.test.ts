import { describe, expect, it, vi } from "vitest";
import { hrefForNodeFile, httpOriginFromNodeUrl } from "./host-files.js";

describe("httpOriginFromNodeUrl", () => {
  it("maps ws to http and wss to https, keeping host and port", () => {
    expect(httpOriginFromNodeUrl("ws://127.0.0.1:3948")).toBe("http://127.0.0.1:3948");
    expect(httpOriginFromNodeUrl("wss://example.test/stream")).toBe("https://example.test");
  });

  it("rejects non-websocket URLs", () => {
    expect(httpOriginFromNodeUrl("http://127.0.0.1:3948")).toBeNull();
    expect(httpOriginFromNodeUrl("not-a-url")).toBeNull();
  });
});

describe("hrefForNodeFile", () => {
  const origin = "http://127.0.0.1:3948";

  it("builds an HTTP /files href with the encoded path, never file://", () => {
    const href = hrefForNodeFile(origin, "/tmp/Screenshot 1.png");
    expect(href.startsWith("http://")).toBe(true);
    expect(href.includes("file:")).toBe(false);
    expect(href).toBe(`${origin}/files?path=${encodeURIComponent("/tmp/Screenshot 1.png")}`);
  });

  it("appends #L<n> when a line is given", () => {
    expect(hrefForNodeFile(origin, "/workspace/src/a.ts", 12)).toBe(
      `${origin}/files?path=${encodeURIComponent("/workspace/src/a.ts")}#L12`,
    );
  });

  it("maps a node ws URL through httpOriginFromNodeUrl then hrefForNodeFile", () => {
    const mapped = httpOriginFromNodeUrl("ws://127.0.0.1:3948");
    expect(mapped).toBe(origin);
    expect(hrefForNodeFile(mapped ?? "", "/tmp/a.ts", 3)).toBe("http://127.0.0.1:3948/files?path=%2Ftmp%2Fa.ts#L3");
  });
});

describe("hrefForNodeFile with the node token", () => {
  const origin = "http://127.0.0.1:3948";

  it("appends the encoded token before the #L anchor", () => {
    expect(hrefForNodeFile(origin, "/tmp/a.ts", 3, "t/k+1")).toBe(
      `${origin}/files?path=%2Ftmp%2Fa.ts&token=${encodeURIComponent("t/k+1")}#L3`,
    );
  });

  it("omits the token param when there is none", () => {
    expect(hrefForNodeFile(origin, "/tmp/a.ts", undefined, null)).toBe(`${origin}/files?path=%2Ftmp%2Fa.ts`);
  });
});

describe("hostFiles.hrefForPath in the browser", () => {
  const origin = "http://127.0.0.1:3948";

  it("reads node and token from the page URL", async () => {
    vi.stubGlobal("window", { location: { search: "?node=ws://127.0.0.1:3948&token=sek" } });
    try {
      const { hostFiles } = await import("./host-files.js");
      expect(hostFiles.hrefForPath("/tmp/a.ts", 7)).toBe(`${origin}/files?path=%2Ftmp%2Fa.ts&token=sek#L7`);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

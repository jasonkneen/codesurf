import { describe, expect, it } from "vitest";
import { existsSync, isAbsolute, join, resolve, spawn } from "./node-stubs.js";

describe("web node stubs", () => {
  it("never reports a local file as present", () => {
    expect(existsSync("/etc/passwd")).toBe(false);
    expect(existsSync("README.md")).toBe(false);
  });

  it("joins and resolves without touching the disk", () => {
    expect(join("a", "b", "c")).toBe("a/b/c");
    expect(isAbsolute("/tmp/x")).toBe(true);
    expect(isAbsolute("tmp/x")).toBe(false);
    expect(resolve("/a/b", "../c")).toBe("/a/c");
  });

  it("spawn is a silent no-op so image-viewer open-in-system does not throw", () => {
    expect(() => spawn("open", ["/tmp/x.png"], { detached: true, stdio: "ignore" }).unref()).not.toThrow();
  });
});

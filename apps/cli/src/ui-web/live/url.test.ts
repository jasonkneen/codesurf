import { describe, expect, it } from "vitest";
import { nodeUrlFromSearch, sessionIdFromSearch, tokenFromSearch } from "./url.js";

describe("nodeUrlFromSearch", () => {
  it("returns null when the param is absent", () => {
    expect(nodeUrlFromSearch("")).toBeNull();
    expect(nodeUrlFromSearch("scene=widgets")).toBeNull();
  });

  it("accepts ws and wss URLs", () => {
    expect(nodeUrlFromSearch("?node=ws://127.0.0.1:3948")).toBe("ws://127.0.0.1:3948/");
    expect(nodeUrlFromSearch("node=wss://example.test/stream")).toBe("wss://example.test/stream");
  });

  it("rejects http and garbage so a typo cannot leave the parity scenes", () => {
    expect(nodeUrlFromSearch("?node=http://127.0.0.1:3948")).toBeNull();
    expect(nodeUrlFromSearch("?node=not-a-url")).toBeNull();
    expect(nodeUrlFromSearch("?node=")).toBeNull();
  });
});

describe("sessionIdFromSearch", () => {
  it("returns the session id when present", () => {
    expect(sessionIdFromSearch("?node=ws://127.0.0.1:3948&session=abc")).toBe("abc");
  });

  it("returns null when absent or blank", () => {
    expect(sessionIdFromSearch("?node=ws://127.0.0.1:3948")).toBeNull();
    expect(sessionIdFromSearch("?session=")).toBeNull();
    expect(sessionIdFromSearch("?session=   ")).toBeNull();
  });
});

describe("tokenFromSearch", () => {
  it("reads ?token= with or without the leading ?", () => {
    expect(tokenFromSearch("?node=ws://h:1&token=abc")).toBe("abc");
    expect(tokenFromSearch("token=a%2Bb")).toBe("a+b");
  });

  it("returns null when absent or blank", () => {
    expect(tokenFromSearch("?node=ws://h:1")).toBeNull();
    expect(tokenFromSearch("?token=%20")).toBeNull();
  });
});

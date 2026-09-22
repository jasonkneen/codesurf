import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayTokenPath, readTokenSync, resolveGatewayToken, resolveToken, tokenPath } from "./token";

describe("gateway token", () => {
  let home: string;

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    delete process.env.CODESURF_GATEWAY_TOKEN;
  });

  it("generates a token file on first use and reuses it afterwards", async () => {
    home = await mkdtemp(join(tmpdir(), "codesurf-gw-token-"));
    const first = await resolveGatewayToken(home);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const second = await resolveGatewayToken(home);
    expect(second).toBe(first);
    expect((await readFile(gatewayTokenPath(home), "utf8")).trim()).toBe(first);
  });

  it("prefers the environment token over the file", async () => {
    home = await mkdtemp(join(tmpdir(), "codesurf-gw-token-env-"));
    process.env.CODESURF_GATEWAY_TOKEN = "env-token-abc";
    await resolveGatewayToken(home);
    expect(await resolveGatewayToken(home)).toBe("env-token-abc");
  });
});

describe("node token (C1)", () => {
  let home: string;

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    delete process.env.CODESURF_NODE_TOKEN;
  });

  it("generates a separate 0600 node token and reads it back synchronously", async () => {
    home = await mkdtemp(join(tmpdir(), "codesurf-node-token-"));
    expect(readTokenSync("node", home)).toBeNull();
    const token = await resolveToken("node", home);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(await resolveToken("gateway", home));
    expect(readTokenSync("node", home)).toBe(token);
    expect((await stat(tokenPath("node", home))).mode & 0o777).toBe(0o600);
  });
});

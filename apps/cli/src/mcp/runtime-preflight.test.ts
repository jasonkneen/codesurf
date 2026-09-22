import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpServerConfig } from "../utils/settings";
import { resolveCommandPath } from "./command-exists";
import { buildMcpToolSet } from "./runtime";

const FIXTURE_PATH = resolve(__dirname, "fixtures/test-server.ts");
const WRAPPER_NAME = "codesurf-fixture-mcp";
const bunPath = resolveCommandPath("bun");

// The wrapper is an executable that only exists inside an isolated fixture
// directory — never on the host PATH or under the host cwd — so the only way
// the preflight (and the real spawn behind it) can find it is by honouring
// the server's configured cwd or PATH.
describe.skipIf(process.platform === "win32" || !bunPath)("buildMcpToolSet stdio preflight", () => {
  let fixtureDir: string;
  let binDir: string;

  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "codesurf-mcp-preflight-"));
    binDir = join(fixtureDir, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, WRAPPER_NAME), `#!/bin/sh\nexec "${bunPath}" "${FIXTURE_PATH}" "$@"\n`, {
      mode: 0o755,
    });
  });

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  function stdioServer(id: string, overrides: Partial<McpServerConfig>): McpServerConfig {
    return { id, label: id, enabled: true, transport: "stdio", ...overrides };
  }

  it("connects to a command given relative to the server's configured cwd", async () => {
    const bundle = await buildMcpToolSet([
      stdioServer("cwd-relative", { command: `./bin/${WRAPPER_NAME}`, cwd: fixtureDir }),
    ]);
    try {
      expect(bundle.errors).toEqual([]);
      expect(bundle.serverIds).toEqual(["cwd-relative"]);
      expect(Object.keys(bundle.tools)).toEqual(["mcp_cwd-relative__echo"]);
    } finally {
      await bundle.close();
    }
  }, 15_000);

  it("connects to a command that is only on the server's configured PATH", async () => {
    const bundle = await buildMcpToolSet([
      stdioServer("env-path", {
        command: WRAPPER_NAME,
        env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
      }),
    ]);
    try {
      expect(bundle.errors).toEqual([]);
      expect(bundle.serverIds).toEqual(["env-path"]);
      expect(Object.keys(bundle.tools)).toEqual(["mcp_env-path__echo"]);
    } finally {
      await bundle.close();
    }
  }, 15_000);

  it("reports a clear error when the command does not resolve in the configured context", async () => {
    const bundle = await buildMcpToolSet([
      stdioServer("missing", { command: WRAPPER_NAME, cwd: fixtureDir, env: { PATH: fixtureDir } }),
    ]);
    try {
      expect(bundle.serverIds).toEqual([]);
      expect(bundle.errors).toEqual([
        `missing: command not found (searched cwd ${fixtureDir} and the server's configured PATH): ${WRAPPER_NAME}`,
      ]);
    } finally {
      await bundle.close();
    }
  });
});

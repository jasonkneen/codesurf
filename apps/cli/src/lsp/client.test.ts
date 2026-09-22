import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { afterEach, describe, expect, it } from "vitest";
import { createLspClientSession } from "./client";

// A language server that answers `initialize`, then ignores `shutdown` and
// SIGTERM entirely. Before stop() was bounded, closing this session hung the
// caller forever on the unanswered shutdown request.
const STUBBORN_SERVER = `
  process.on("SIGTERM", () => {});
  let buffer = Buffer.alloc(0);
  const send = (message) => {
    const body = JSON.stringify(message);
    process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
  };
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
      if (headerEnd < 0) return;
      const match = /Content-Length: (\\d+)/i.exec(buffer.slice(0, headerEnd).toString());
      if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }
      const length = Number(match[1]);
      if (buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString());
      buffer = buffer.slice(headerEnd + 4 + length);
      if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
      // "shutdown" is deliberately never answered.
    }
  });
  setInterval(() => {}, 1000);
`;

// A cooperative language server that records the `initialize` params it
// received to the file named by CODESURF_LSP_TEST_OUT, then answers initialize/shutdown and
// exits on `exit`.
const RECORDING_SERVER = `
  const fs = require("fs");
  const outFile = process.env.CODESURF_LSP_TEST_OUT;
  let buffer = Buffer.alloc(0);
  const send = (message) => {
    const body = JSON.stringify(message);
    process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
  };
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
      if (headerEnd < 0) return;
      const match = /Content-Length: (\\d+)/i.exec(buffer.slice(0, headerEnd).toString());
      if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }
      const length = Number(match[1]);
      if (buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString());
      buffer = buffer.slice(headerEnd + 4 + length);
      if (message.method === "initialize") {
        fs.writeFileSync(outFile, JSON.stringify(message.params));
        send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
      } else if (message.method === "shutdown") {
        send({ jsonrpc: "2.0", id: message.id, result: null });
      } else if (message.method === "exit") {
        process.exit(0);
      }
    }
  });
  setInterval(() => {}, 1000);
`;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createLspClientSession initialize", () => {
  it("sends the CodeSurf process PID as processId, not the server child's PID", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codesurf-lsp-init-"));
    tempDirs.push(root);
    const recorded = path.join(root, "initialize.json");

    const session = await createLspClientSession({
      serverId: "recording",
      root,
      launch: { command: process.execPath, args: ["-e", RECORDING_SERVER], env: { CODESURF_LSP_TEST_OUT: recorded } },
      startupTimeoutMs: 10_000,
      diagnosticsDebounceMs: 0,
      shutdownTimeoutMs: 1_000,
      exitGraceMs: 1_000,
    });

    try {
      const params = JSON.parse(await readFile(recorded, "utf8")) as { processId: unknown; rootUri: string };
      // Servers use `processId` to watch the *client* for exit; the child's own
      // PID would make that check meaningless.
      expect(params.processId).toBe(process.pid);
      expect(params.rootUri).toBe(pathToFileURL(root).href);
    } finally {
      await session.stop();
    }
  }, 20_000);
});

describe("createLspClientSession.stop", () => {
  it("bounds teardown of a server that ignores shutdown and SIGTERM", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codesurf-lsp-stop-"));
    tempDirs.push(root);

    const session = await createLspClientSession({
      serverId: "stubborn",
      root,
      launch: { command: process.execPath, args: ["-e", STUBBORN_SERVER] },
      startupTimeoutMs: 10_000,
      diagnosticsDebounceMs: 0,
      shutdownTimeoutMs: 200,
      exitGraceMs: 200,
    });

    const startedAt = Date.now();
    const first = session.stop();
    const second = session.stop();
    // Concurrent callers join one teardown instead of racing separate ones.
    expect(second).toBe(first);
    await first;
    const elapsed = Date.now() - startedAt;

    // shutdown timeout + exit grace + SIGTERM grace + SIGKILL grace ≈ 800ms;
    // anything near the 20s test timeout means the old unbounded wait is back.
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);
});

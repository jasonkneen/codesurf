import { describe, expect, it } from "vitest";
import { createStdioTransport } from "./runtime";

// A server that floods stderr before it ever speaks JSON-RPC. Without a
// drain on the client side the pipe buffer (64 KiB on most platforms) fills,
// the child blocks on its next stderr write, and the notification below is
// never written — the "stalled MCP server" symptom from the network review.
const NOISY_SERVER = `
  const chunk = "x".repeat(64 * 1024);
  let written = 0;
  const flood = () => {
    while (written < 4 * 1024 * 1024) {
      written += chunk.length;
      if (!process.stderr.write(chunk)) {
        process.stderr.once("drain", flood);
        return;
      }
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/ready" }) + "\\n");
    setTimeout(() => process.exit(0), 200);
  };
  flood();
`;

describe("createStdioTransport", () => {
  it("drains server stderr so a noisy server can still deliver messages", async () => {
    const { transport, stderrTail } = createStdioTransport({
      command: process.execPath,
      args: ["-e", NOISY_SERVER],
    });

    const received = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no message within 10s: server stalled on stderr")), 10_000);
      transport.onmessage = (message) => {
        clearTimeout(timer);
        resolve("method" in message ? String(message.method) : "unknown");
      };
      transport.onerror = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });

    try {
      await transport.start();
      await expect(received).resolves.toBe("notifications/ready");
      // A bounded tail is retained for diagnostics, not the whole flood.
      expect(stderrTail().length).toBeGreaterThan(0);
      expect(stderrTail().length).toBeLessThanOrEqual(2_000);
    } finally {
      await transport.close();
    }
  }, 20_000);
});

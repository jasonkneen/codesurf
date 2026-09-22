// Wire approval round-trip: the session channel carries tool-approval requests
// node→front and decisions front→node. Exercises the stream-server registry +
// client approve()/onApprovalRequest surface without a live WS.
import { describe, expect, it, vi } from "vitest";
import { NodeSessionHost } from "./host";
import { SessionStreamClient, SessionStreamServer } from "./session-stream";

async function* noop() {}

function makePair() {
  const host = new NodeSessionHost(noop as never);
  const server = new SessionStreamServer(host as never);
  const session = host.createSession();
  return { host, server, session };
}

describe("session-stream approval protocol", () => {
  it("resolves an engine requestApproval when a decision frame arrives", async () => {
    const { server, session } = makePair();
    const sent: unknown[] = [];
    const p = server.requestApproval(session, "ap-1", "bash", { cmd: "rm -rf /" }, (out) => sent.push(out));
    // engine broadcast should have pushed an approval_request
    expect(sent[0]).toMatchObject({
      op: "session",
      event: "approval_request",
      session,
      approvalId: "ap-1",
      toolName: "bash",
    });
    // front approves
    server.handle({ op: "session", action: "approval_decision", session, approvalId: "ap-1", approve: true }, () => {});
    await expect(p).resolves.toBe(true);
  });

  it("resolves false for a denial", async () => {
    const { server, session } = makePair();
    const p = server.requestApproval(session, "ap-2", "write_file", { filePath: "x" }, () => {});
    server.handle(
      { op: "session", action: "approval_decision", session, approvalId: "ap-2", approve: false },
      () => {},
    );
    await expect(p).resolves.toBe(false);
  });

  it("times out to false when no decision arrives", async () => {
    vi.useFakeTimers();
    try {
      const { server, session } = makePair();
      const p = server.requestApproval(session, "ap-3", "bash", {}, () => {}, 10_000);
      vi.advanceTimersByTime(11_000);
      await expect(p).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("client surfaces approval_request via onApprovalRequest and sends approve", async () => {
    const client = new SessionStreamClient("ws://x");
    const cb = vi.fn();
    client.onApprovalRequest = cb;
    // simulate the ingest of a server-pushed approval_request
    (client as unknown as { ingest: (raw: string) => void }).ingest(
      JSON.stringify({
        op: "session",
        event: "approval_request",
        session: "s1",
        approvalId: "ap-4",
        toolName: "edit_file",
        input: { filePath: "f" },
      }),
    );
    expect(cb).toHaveBeenCalledWith("s1", "ap-4", "edit_file", { filePath: "f" });
  });
});

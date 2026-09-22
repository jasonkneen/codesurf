import { describe, expect, it, vi } from "vitest";
import { Hub } from "./hub";
import { RelayNode, type RemoteTool } from "./node";
import { type RelayMessage, relayMessage } from "./protocol";
import { Steward } from "./steward";
import { connectPeerPair, type RelayHandler, type RelayTransport } from "./transport";

function workerTool(name: string, reply: string): RemoteTool {
  return { name, description: name, run: () => ({ statement: reply, anchors: [], handle: name }) };
}

async function buildMesh() {
  const hub = new Hub("hub");
  const [bOut, bIn] = connectPeerPair();
  const bSteward = new Steward({ allow: { nodeB_ping: ["nodeA"] } });
  const b = new RelayNode("nodeB", bOut, bSteward);
  b.registerTool(workerTool("nodeB_ping", "pong"));
  hub.attach("nodeB", bIn);

  const [cOut, cIn] = connectPeerPair();
  const c = new RelayNode("nodeC", cOut, new Steward({ allow: { nodeC_grep: ["nodeA"] } }));
  c.registerTool(workerTool("nodeC_grep", "2 results"));
  hub.attach("nodeC", cIn);

  const [aOut, aIn] = connectPeerPair();
  const a = new RelayNode("nodeA", aOut, new Steward({ allow: {} }));
  hub.attach("nodeA", aIn);

  await a.start();
  await b.start({ repo: "repo:/clientB" });
  await c.start({ repo: "repo:/clientX" });
  return { hub, a, b, c, bSteward };
}

describe("hub protocol (Phase 3 slice 1)", () => {
  it("discovers nodes by capability", async () => {
    const { a } = await buildMesh();
    const ping = await a.discover({ capabilities: ["nodeB_ping"] });
    expect(ping).toContain("nodeB");
    expect(ping).not.toContain("nodeC");
    const grep = await a.discover({ capabilities: ["nodeC_grep"] });
    expect(grep).toContain("nodeC");
  });

  it("routes to the node owning a repo", async () => {
    const { a } = await buildMesh();
    expect(await a.locate("repo:/clientX")).toBe("nodeC");
    expect(await a.locate("repo:/clientB")).toBe("nodeB");
    expect(await a.locate("repo:/none")).toBeNull();
  });

  it("delegates a job through the hub to the owning node (bounded reply + audit)", async () => {
    const { a, bSteward } = await buildMesh();
    const reply = await a.delegate("hub", "nodeB_ping", {}, "nodeA", "repo:/work");
    expect(reply.ok).toBe(true);
    expect(reply.statement).toBe("pong");
    expect(reply.auditId).toBeTruthy();
    const audit = bSteward.auditLog();
    expect(audit.some((e) => e.auditId === reply.auditId)).toBe(true);
  });

  it("routes to the right worker when two offer different capabilities", async () => {
    const { a } = await buildMesh();
    const grepReply = await a.delegate("hub", "nodeC_grep", { q: "x" }, "nodeA", "repo:/work");
    expect(grepReply.ok).toBe(true);
    expect(grepReply.statement).toBe("2 results");
  });

  it("denies a delegated job when the worker steward refuses the principal", async () => {
    const { hub } = await buildMesh();
    const [eOut, eIn] = connectPeerPair();
    const e = new RelayNode("nodeE", eOut, new Steward({ allow: {} }));
    hub.attach("nodeE", eIn);
    // nodeE claims to be the allowed principal; the hub gates on the spoke's
    // bound identity (nodeE), so the claim changes nothing.
    const reply = await e.delegate("hub", "nodeB_ping", {}, "nodeA", "repo:/work");
    expect(reply.ok).toBe(false);
    expect(reply.reason).toMatch(/principal nodeE not allowed/);
  });

  it("reports no-node when a capability is not served anywhere", async () => {
    const { a } = await buildMesh();
    const reply = await a.delegate("hub", "nodeZ_unknown", {}, "nodeA", "repo:/work");
    expect(reply.ok).toBe(false);
    expect(reply.reason).toMatch(/no node offers/);
  });
});

describe("hub presence", () => {
  it("retires a node from discovery when it leaves", async () => {
    const { hub, a, b } = await buildMesh();
    expect(await a.discover({ capabilities: ["nodeB_ping"] })).toContain("nodeB");
    await b.leave();
    // hub no longer discovers nodeB (registry cleaned on presence leave)
    expect(await a.discover({ capabilities: ["nodeB_ping"] })).not.toContain("nodeB");
    const ids = hub.peers().map((p) => p.nodeId);
    expect(ids).not.toContain("nodeB");
  });

  it("reflects heartbeat in peer lastSeen without dropping the node", async () => {
    const { hub, b } = await buildMesh();
    const before = hub.peers().find((p) => p.nodeId === "nodeB")?.lastSeen ?? 0;
    await b.presence("heartbeat");
    const after = hub.peers().find((p) => p.nodeId === "nodeB")?.lastSeen ?? 0;
    expect(after).toBeGreaterThanOrEqual(before);
    expect(hub.peers().some((p) => p.nodeId === "nodeB")).toBe(true);
  });
});

/** A raw wire spoke: the test injects frames as if a remote socket sent them. */
class FakeWireSpoke implements RelayTransport {
  readonly sent: RelayMessage[] = [];
  private readonly handlers: RelayHandler[] = [];
  failSends = false;

  async send(message: RelayMessage): Promise<void> {
    if (this.failSends) throw new Error("transport closed");
    this.sent.push(message);
  }

  onMessage(handler: RelayHandler): void {
    this.handlers.push(handler);
  }

  async close(): Promise<void> {}

  inject(message: unknown): void {
    for (const handler of this.handlers) handler(message as RelayMessage);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("hub wire hardening (H3/H4)", () => {
  it("drops malformed frames and survives a failing reply send without an unhandled rejection", async () => {
    const hub = new Hub("hub");
    const spoke = new FakeWireSpoke();
    hub.attachAny(spoke);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      // Malformed: capabilities is not a string array (hub.discover would throw on it).
      spoke.inject(
        relayMessage({ op: "discover", from: "x", to: "hub", seq: 1, ttlMs: 1000, payload: { capabilities: 5 } }),
      );
      spoke.inject({ protocolVersion: 1, op: "announce", from: 7, to: "*", seq: 1, ttlMs: 1, payload: null });
      spoke.inject("not even an object");
      // Well-formed, but the reply send rejects (socket died mid-reply).
      spoke.failSends = true;
      spoke.inject(relayMessage({ op: "discover", from: "x", to: "hub", seq: 2, ttlMs: 1000, payload: {} }));
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
      expect(hub.peers()).toEqual([]);

      // The hub keeps serving the next message.
      spoke.failSends = false;
      spoke.inject(relayMessage({ op: "discover", from: "x", to: "hub", seq: 3, ttlMs: 1000, payload: {} }));
      await settle();
      expect(spoke.sent.map((m) => m.op)).toEqual(["discover_reply"]);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("a wire spoke cannot speak as a node id another spoke owns (announce, presence leave)", async () => {
    const hub = new Hub("hub");
    const owner = new FakeWireSpoke();
    const attacker = new FakeWireSpoke();
    hub.attachAny(owner);
    hub.attachAny(attacker);
    owner.inject(
      relayMessage({ op: "announce", from: "worker", to: "*", seq: 1, ttlMs: 1000, payload: { capabilities: ["t"] } }),
    );
    await settle();
    attacker.inject(
      relayMessage({
        op: "announce",
        from: "worker",
        to: "*",
        seq: 1,
        ttlMs: 1000,
        payload: { capabilities: ["evil"] },
      }),
    );
    attacker.inject(
      relayMessage({
        op: "presence",
        from: "worker",
        to: "hub",
        seq: 2,
        ttlMs: 1000,
        payload: { status: "leave", at: "" },
      }),
    );
    await settle();
    expect(hub.peers()).toEqual([expect.objectContaining({ nodeId: "worker", capabilities: ["t"] })]);
  });

  it("stamps the transport's authenticated principal on forwarded requests and only relays forwarded replies", async () => {
    const hub = new Hub("hub");
    const worker = new FakeWireSpoke();
    const client = new FakeWireSpoke();
    hub.attachAny(worker, { principal: "wire" });
    hub.attachAny(client, { principal: "wire" });
    worker.inject(
      relayMessage({ op: "announce", from: "w", to: "*", seq: 1, ttlMs: 1000, payload: { capabilities: ["t"] } }),
    );
    await settle();
    client.inject(
      relayMessage({
        op: "delegate_request",
        from: "c",
        to: "hub",
        seq: 9,
        ttlMs: 1000,
        payload: { tool: "t", args: {}, principal: "admin", scope: "s" },
      }),
    );
    await settle();
    const forwarded = worker.sent.find((m) => m.op === "delegate_request");
    expect((forwarded?.payload as { principal: string }).principal).toBe("wire");

    // A forged reply (never forwarded) to client c is dropped; the real one relays once.
    worker.inject(
      relayMessage({
        op: "delegate_reply",
        from: "w",
        to: "c",
        seq: 99,
        ttlMs: 1000,
        payload: { ok: true, auditId: "x" },
      }),
    );
    worker.inject(
      relayMessage({
        op: "delegate_reply",
        from: "w",
        to: "c",
        seq: 9,
        ttlMs: 1000,
        payload: { ok: true, auditId: "a" },
      }),
    );
    worker.inject(
      relayMessage({
        op: "delegate_reply",
        from: "w",
        to: "c",
        seq: 9,
        ttlMs: 1000,
        payload: { ok: true, auditId: "b" },
      }),
    );
    await settle();
    expect(
      client.sent.filter((m) => m.op === "delegate_reply").map((m) => (m.payload as { auditId: string }).auditId),
    ).toEqual(["a"]);
  });
});

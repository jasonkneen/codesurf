import { describe, expect, it } from "vitest";
import { BoundedEnvelope, enforceBudget, relaySafe } from "./envelope";
import { RelayNode, type RemoteTool } from "./node";
import { Steward } from "./steward";
import { connectPeerPair } from "./transport";

const PING: RemoteTool = {
  name: "nodeB_ping",
  description: "Steward-scoped ping tool on node B",
  run: (_args) => ({ statement: "pong", anchors: [{ name: "ping.result", gate: "steward" }], handle: "h1" }),
};

describe("bounded envelope", () => {
  it("refuses a payload over budget at construction", () => {
    // A body that fits under budget constructs fine and is bounded-safe.
    expect(new BoundedEnvelope("A", { statement: "s", anchors: [] }).payload.statement).toBe("s");
    // enforceBudget throws for over-budget input.
    expect(() => enforceBudget({ statement: "x".repeat(5000) }, 1024)).toThrow(/over budget/);
  });

  it("flags raw content as not relay-safe", () => {
    // relay-safe envelope (relayOnly) without raw content is fine.
    expect(
      () => new BoundedEnvelope("A", { statement: "s", anchors: [] }, 4096, 30_000, "bounded", true),
    ).not.toThrow();
    // raw content is refused on the relay tier.
    expect(() => relaySafe({ content: "FILE CONTENTS" })).toThrow(/forbids raw content/);
  });
});

describe("steward gate", () => {
  const steward = new Steward({ allow: { nodeB_ping: ["nodeA"] } });

  it("allows an authorized principal and audits", () => {
    const gate = steward.authorize("nodeA", "nodeB_ping", "repo:/work");
    expect(gate.allowed).toBe(true);
    const log = steward.auditLog();
    expect(log[log.length - 1].allowed).toBe(true);
    expect(log[log.length - 1].principal).toBe("nodeA");
  });

  it("denies an unauthorized principal with a reason and audits", () => {
    const gate = steward.authorize("nodeC", "nodeB_ping", "repo:/work");
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/nodeC/);
    const log = steward.auditLog();
    expect(log[log.length - 1].allowed).toBe(false);
  });
});

describe("two-node delegated bounded call (Phase 2 W3)", () => {
  async function buildPair() {
    const [aTx, bTx] = connectPeerPair();
    const bSteward = new Steward({ allow: { nodeB_ping: ["nodeA"] } });
    const b = new RelayNode("nodeB", bTx, bSteward);
    b.registerTool(PING);
    const a = new RelayNode("nodeA", aTx, new Steward({ allow: {} }));
    await a.start();
    await b.start();
    return { a, b, bSteward };
  }

  it("exchanges a delegated bounded call with audit", async () => {
    const { a, b, bSteward } = await buildPair();
    try {
      const reply = await a.delegate("nodeB", "nodeB_ping", {}, "nodeA", "repo:/work");
      expect(reply.ok).toBe(true);
      expect(reply.statement).toBe("pong");
      expect(reply.handle).toBe("h1");
      expect(reply.auditId).toBeTruthy();
      const audit = bSteward.auditLog();
      expect(audit.some((e) => e.auditId === reply.auditId && e.allowed)).toBe(true);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("denies a call for an unauthorized principal (bounded, no raw content)", async () => {
    const { a, b } = await buildPair();
    try {
      const reply = await a.delegate("nodeB", "nodeB_ping", {}, "nodeE", "repo:/work");
      expect(reply.ok).toBe(false);
      expect(reply.reason).toBeTruthy();
      expect(reply.statement).toBeUndefined();
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("refuses an over-budget reply through the bounded envelope", async () => {
    const [aTx, bTx] = connectPeerPair();
    const bSteward = new Steward({ allow: { nodeB_big: ["nodeA"] } });
    const b = new RelayNode("nodeB", bTx, bSteward);
    b.registerTool({
      name: "nodeB_big",
      description: "returns an oversized payload",
      budgetBytes: 128,
      run: () => ({ statement: "z".repeat(5000), anchors: [] }),
    });
    const a = new RelayNode("nodeA", aTx, new Steward({ allow: {} }));
    await a.start();
    await b.start();
    try {
      const reply = await a.delegate("nodeB", "nodeB_big", {}, "nodeA", "repo:/work");
      expect(reply.ok).toBe(false);
      expect(reply.reason).toMatch(/over budget/);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("expand(handle) re-enters the same steward gate", async () => {
    const { a, b } = await buildPair();
    try {
      const expanded = await a.expand("nodeB", "nodeB_ping", "h1", "nodeA", "repo:/work");
      expect(expanded.ok).toBe(true);
      const denied = await a.expand("nodeB", "nodeB_ping", "h1", "nodeE", "repo:/work");
      expect(denied.ok).toBe(false);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

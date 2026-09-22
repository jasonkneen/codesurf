import { describe, expect, it } from "vitest";
import { Hub } from "./hub";
import { RelayNode } from "./node";
import { Steward } from "./steward";
import { nextTraceId, renderTraceTrajectory } from "./trace";
import { connectPeerPair } from "./transport";

describe("relay tracing (full traceroute)", () => {
  it("records the full path of a traced delegate: forward -> run -> reply", async () => {
    const hub = new Hub("hub");
    const [wOut, wIn] = connectPeerPair();
    const worker = new RelayNode("W", wOut, new Steward({ allow: { ping: ["client"] } }));
    worker.registerTool({
      name: "ping",
      description: "p",
      run: () => ({ statement: "pong", anchors: [], handle: "h" }),
    });
    hub.attach("W", wIn);
    await worker.start();

    const [cOut, hIn] = connectPeerPair();
    const client = new RelayNode("client", cOut, new Steward({ allow: {} }));
    hub.attach("client", hIn);
    await client.start();

    const traceId = nextTraceId();
    const reply = await client.delegate("hub", "ping", {}, "client", "s", { target: "W", traceId });
    expect(reply.ok).toBe(true);
    expect(reply.statement).toBe("pong");

    const spans = hub.trace(traceId);
    expect(spans.length).toBeGreaterThanOrEqual(3);
    const events = spans.map((s) => s.event);
    expect(events).toContain("forward");
    expect(events).toContain("run");
    expect(events).toContain("reply");
    const run = spans.find((s) => s.event === "run");
    expect(run?.node).toBe("W");
    expect(run?.status).toBe("ok");

    const rendered = renderTraceTrajectory(spans);
    expect(rendered).toContain("trace " + traceId);
    expect(rendered).toContain("forward");
    expect(rendered).toContain("run");
    expect(rendered).toContain("reply");
  });
});

import { describe, expect, it } from "vitest";
import { Hub } from "./hub";
import { JobHost, registerJobTools } from "./jobs";
import { RelayNode } from "./node";
import { Steward } from "./steward";
import { connectPeerPair } from "./transport";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ALLOW: Record<string, string[]> = { job_submit: ["client"], job_status: ["client"], job_cancel: ["client"] };

async function build() {
  const hub = new Hub("hub");
  const w1 = new JobHost(async () => ({ statement: "ran on W1", anchors: [], handle: "h" }));
  const w2 = new JobHost(async (_s) => {
    await sleep(40);
    return { statement: "ran on W2", anchors: [], handle: "h" };
  });
  const mk = (id: string, _repo: string, _load: number, host: JobHost) => {
    const [tx, hubTx] = connectPeerPair();
    const node = new RelayNode(id, tx, new Steward({ allow: ALLOW }));
    registerJobTools(node, host);
    hub.attach(id, hubTx);
    return { node, host };
  };
  const a = mk("W1", "repo:/A", 4, w1);
  const b = mk("W2", "repo:/B", 1, w2);
  await a.node.start({ repo: "repo:/A", load: 4 });
  await b.node.start({ repo: "repo:/B", load: 1 });
  return { hub, a, b };
}

describe("distributed compute jobs (Phase 3)", () => {
  it("places a job by locality, else least load, else explicit target", async () => {
    const { hub } = await build();
    expect(hub.placement({ tool: "job_submit", repo: "repo:/A" })).toBe("W1");
    expect(hub.placement({ tool: "job_submit", repo: "repo:/B" })).toBe("W2");
    expect(hub.placement({ tool: "job_submit" })).toBe("W2"); // load 1 < 4
    expect(hub.placement({ tool: "job_submit", target: "W1" })).toBe("W1");
  });

  it("a client submits and polls a distributed job to completion (bounded + audited)", async () => {
    const { hub, b } = await build();
    const [cOut, hIn] = connectPeerPair();
    const client = new RelayNode("client", cOut, new Steward({ allow: {} }));
    hub.attach("client", hIn);
    await client.start();

    const sub = await client.delegate(
      "hub",
      "job_submit",
      { type: "search", tool: "job_submit", args: { q: "x" }, principal: "client", scope: "s" },
      "client",
      "s",
      { target: "W2" },
    );
    expect(sub.ok).toBe(true);
    const jobId = JSON.parse(sub.statement ?? "{}").id;

    let done = false;
    let resultStatement = "";
    let attempts = 0;
    while (!done && attempts < 50) {
      const st = await client.delegate("hub", "job_status", { id: jobId }, "client", "s", { target: "W2" });
      const parsed = JSON.parse(st.statement ?? "{}");
      if (parsed.status === "done") {
        done = true;
        resultStatement = parsed.result?.statement ?? "";
      }
      await sleep(25);
      attempts++;
    }
    expect(done).toBe(true);
    expect(resultStatement).toBe("ran on W2");
    expect(b.host.load()).toBe(0);
  });

  it("live load (heartbeat) updates placement to the least-loaded node", async () => {
    const hub = new Hub("hub");
    const mk = (id: string, host: JobHost) => {
      const [tx, hubTx] = connectPeerPair();
      const node = new RelayNode(id, tx, new Steward({ allow: ALLOW }));
      registerJobTools(node, host);
      hub.attach(id, hubTx);
      return { node, host };
    };
    const w1 = mk("W1", new JobHost(async () => ({ statement: "a", anchors: [], handle: "h" })));
    const looper = new JobHost(async () => {
      await sleep(250);
      return { statement: "done", anchors: [], handle: "h" };
    });
    const w2 = mk("W2", looper);
    await w1.node.start({ load: 0 });
    await w2.node.start({ load: 0 });

    expect(hub.peers().find((p) => p.nodeId === "W2")?.load).toBe(0);
    w2.host.submit({ type: "t", tool: "job_submit", args: {}, principal: "client", scope: "s" });
    expect(w2.host.load()).toBe(1);
    await w2.node.reportLoad(w2.host.load());
    expect(hub.peers().find((p) => p.nodeId === "W2")?.load).toBe(1);
    expect(hub.placement({ tool: "job_submit" })).toBe("W1"); // 0 < 1
  });
});

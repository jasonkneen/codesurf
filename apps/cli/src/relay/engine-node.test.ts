import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EngineNode } from "./engine-node";
import { RelayNode } from "./node";
import { Steward } from "./steward";
import { nextTraceId } from "./trace";
import { WsRelayClient } from "./ws-transport";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function* runner(_id: string, message: string, _signal: AbortSignal) {
  yield { type: "content" as const, content: `reply:${message}` };
  await sleep(35);
  yield { type: "content" as const, content: " done" };
}

describe("runnable engine node over the wire (Phase 3)", () => {
  let node: EngineNode;
  let url: string;

  beforeAll(async () => {
    node = new EngineNode({ turnRunner: runner, allowPrincipals: ["front1", "front2"], port: 0 });
    await node.start();
    const start = Date.now();
    while (node.port() === 0 && Date.now() - start < 3000) await sleep(10);
    url = `ws://127.0.0.1:${node.port()}`;
  });

  afterAll(async () => {
    await node.close().catch(() => {});
  });

  async function connect(id: string) {
    const spoke = new WsRelayClient(url);
    const front = new RelayNode(id, spoke, new Steward({ allow: {} }));
    await front.start();
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const nodes = await front.discover({ capabilities: ["session_create"] });
      if (nodes.includes("node0")) return { front, spoke };
      await sleep(25);
    }
    throw new Error("engine node never became discoverable");
  }

  it("a front creates + messages a session, disconnects, and the turn outlives it", async () => {
    const { front, spoke } = await connect("front1");
    const create = await front.delegate("hub", "session_create", {}, "front1", "scope");
    expect(create.ok).toBe(true);
    const sessionId = (create.statement ?? "").replace("created:", "");

    const accepted = await front.delegate("hub", "session_message", { sessionId, text: "hi" }, "front1", "scope");
    expect(accepted.ok).toBe(true);
    expect(accepted.statement).toBe(`accepted:${sessionId}`);

    // Client death: the front vanishes mid-turn; the node keeps running the turn.
    await spoke.close();

    const { front: front2, spoke: spoke2 } = await connect("front2");
    let text = "";
    let finished = false;
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const st = await front2.delegate("hub", "session_status", { sessionId }, "front2", "scope");
      const parsed = JSON.parse(st.statement ?? "{}");
      text = parsed.text;
      finished = parsed.finished;
      if (finished) break;
      await sleep(25);
    }
    expect(finished).toBe(true);
    expect(text).toContain("reply:hi");
    expect(text).toContain("done");

    const rm = await front2.delegate("hub", "session_destroy", { sessionId }, "front2", "scope");
    expect(rm.statement).toBe(`removed:${sessionId}`);
    await spoke2.close();
  });
});
describe("runnable engine node jobs over the wire", () => {
  let node: EngineNode;
  let url: string;

  beforeAll(async () => {
    node = new EngineNode({
      turnRunner: runner,
      jobRunner: async (spec) => ({ statement: `job ran: ${spec.type}`, anchors: [], handle: "x" }),
      allowPrincipals: ["job-front"],
      port: 0,
    });
    await node.start();
    const start = Date.now();
    while (node.port() === 0 && Date.now() - start < 3000) await sleep(10);
    url = `ws://127.0.0.1:${node.port()}`;
  });

  afterAll(async () => {
    await node.close().catch(() => {});
  });

  it("a front submits a distributed job over WS, polls to done, reads the bounded result", async () => {
    const spoke = new WsRelayClient(url);
    const front = new RelayNode("job-front", spoke, new Steward({ allow: {} }));
    await front.start();
    let found = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const nodes = await front.discover({ capabilities: ["job_submit"] });
      if (nodes.includes("node0")) {
        found = true;
        break;
      }
      await sleep(25);
    }
    expect(found).toBe(true);

    const sub = await front.delegate(
      "hub",
      "job_submit",
      { type: "search", tool: "job_submit", args: { q: "x" }, principal: "job-front", scope: "s" },
      "job-front",
      "s",
      { target: "node0" },
    );
    expect(sub.ok).toBe(true);
    const jobId = JSON.parse(sub.statement ?? "{}").id;

    let done = false;
    let statement = "";
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const st = await front.delegate("hub", "job_status", { id: jobId }, "job-front", "s", { target: "node0" });
      const parsed = JSON.parse(st.statement ?? "{}");
      if (parsed.status === "done") {
        done = true;
        statement = parsed.result?.statement ?? "";
        break;
      }
      await sleep(25);
    }
    expect(done).toBe(true);
    expect(statement).toBe("job ran: search");
    await spoke.close();
  });
});
describe("fleet telemetry over the wire", () => {
  let node: EngineNode;
  let url: string;

  beforeAll(async () => {
    node = new EngineNode({ turnRunner: runner, allowPrincipals: ["tele-front"], port: 0 });
    await node.start();
    const start = Date.now();
    while (node.port() === 0 && Date.now() - start < 3000) await sleep(10);
    url = `ws://127.0.0.1:${node.port()}`;
  });

  afterAll(async () => {
    await node.close().catch(() => {});
  });

  it("a remote compute node reports status and a front reads the fleet", async () => {
    const wSpoke = new WsRelayClient(url);
    const worker = new RelayNode("worker-1", wSpoke, new Steward({ allow: {} }));
    await worker.start({ load: 3 });
    await worker.reportStatus({ sessions: 4, jobs: 2, version: "0.2.0", uptimeMs: 1500 });

    const fSpoke = new WsRelayClient(url);
    const front = new RelayNode("tele-front", fSpoke, new Steward({ allow: {} }));
    await front.start();

    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const nodes = await front.discover({ capabilities: ["fleet_status"] });
      if (nodes.includes("node0")) break;
      await sleep(25);
    }

    // Poll the fleet until the remote worker's telemetry lands.
    let seenWorker = false;
    const start = Date.now();
    while (Date.now() - start < 5000 && !seenWorker) {
      const res = await front.delegate("hub", "fleet_status", {}, "tele-front", "s", { target: "node0" });
      const fleet = JSON.parse(res.statement ?? "[]") as {
        node: string;
        load: number;
        sessions?: number;
        jobs?: number;
        version?: string;
        uptimeMs?: number;
      }[];
      const w = fleet.find((x) => x.node === "worker-1");
      if (w) {
        expect(w.load).toBe(3);
        expect(w.sessions).toBe(4);
        expect(w.jobs).toBe(2);
        expect(w.version).toBe("0.2.0");
        seenWorker = true;
      }
      await sleep(25);
    }
    expect(seenWorker).toBe(true);
    await wSpoke.close();
    await fSpoke.close();
  });
});

describe("trace_path over the wire", () => {
  let node: EngineNode;
  let url: string;

  beforeAll(async () => {
    node = new EngineNode({
      turnRunner: runner,
      jobRunner: async (spec) => ({ statement: `job ran: ${spec.type}`, anchors: [], handle: "x" }),
      allowPrincipals: ["tr-front"],
      port: 0,
    });
    await node.start();
    const start = Date.now();
    while (node.port() === 0 && Date.now() - start < 3000) await sleep(10);
    url = `ws://127.0.0.1:${node.port()}`;
  });

  afterAll(async () => {
    await node.close().catch(() => {});
  });

  it("renders a full traceroute for a traced job", async () => {
    const spoke = new WsRelayClient(url);
    const front = new RelayNode("tr-front", spoke, new Steward({ allow: {} }));
    await front.start();
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const nodes = await front.discover({ capabilities: ["job_submit"] });
      if (nodes.includes("node0")) break;
      await sleep(25);
    }
    const traceId = nextTraceId();
    const sub = await front.delegate(
      "hub",
      "job_submit",
      { type: "search", tool: "job_submit", args: { q: "x" }, principal: "tr-front", scope: "s" },
      "tr-front",
      "s",
      { target: "node0", traceId },
    );
    expect(sub.ok).toBe(true);

    const tr = await front.delegate("hub", "trace_path", { traceId }, "tr-front", "s", { target: "node0" });
    expect(tr.statement).toContain(`trace ${traceId}`);
    expect(tr.statement).toContain("forward");
    expect(tr.statement).toContain("run");
    expect(tr.statement).toContain("reply");
    await spoke.close();
  });
});

describe("token-protected engine node (C1)", () => {
  it("admits the token-authenticated principal regardless of the claimed one, and refuses a busy session", async () => {
    let release: () => void = () => {};
    async function* slow(_id: string, _m: string, _s: AbortSignal) {
      await new Promise<void>((resolve) => (release = resolve));
      yield { type: "content" as const, content: "late" };
    }
    const node = new EngineNode({ turnRunner: slow, port: 0, authToken: "tok" });
    await node.start();
    const spoke = new WsRelayClient(`ws://127.0.0.1:${node.port()}`, { token: "tok" });
    const front = new RelayNode("front-x", spoke, new Steward({ allow: {} }));
    try {
      await front.start();
      const create = await front.delegate("hub", "session_create", {}, "made-up-principal", "s", { target: "node0" });
      expect(create.ok).toBe(true);
      const sessionId = (create.statement ?? "").replace("created:", "");
      const first = await front.delegate("hub", "session_message", { sessionId, text: "a" }, "x", "s", {
        target: "node0",
      });
      expect(first.statement).toBe(`accepted:${sessionId}`);
      const second = await front.delegate("hub", "session_message", { sessionId, text: "b" }, "x", "s", {
        target: "node0",
      });
      expect(second.statement).toBe(`busy:${sessionId}`);
      release();
    } finally {
      await spoke.close();
      await node.close();
    }
  });
});

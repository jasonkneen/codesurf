import { describe, expect, it } from "vitest";
import { Hub } from "./hub";
import { RelayNode } from "./node";
import { Steward } from "./steward";
import { connectPeerPair } from "./transport";

describe("fleet telemetry", () => {
  it("aggregates node status into a fleet snapshot via presence heartbeat", async () => {
    const hub = new Hub("hub");
    const mk = (id: string) => {
      const [tx, hIn] = connectPeerPair();
      const node = new RelayNode(id, tx, new Steward({ allow: {} }));
      hub.attach(id, hIn);
      return node;
    };
    const n1 = mk("n1");
    const n2 = mk("n2");
    await n1.start({ load: 1 });
    await n2.start({ load: 2 });
    await n1.reportStatus({ sessions: 3, jobs: 1, version: "0.1.1", uptimeMs: 1000 });
    await n2.reportStatus({ sessions: 5, jobs: 0, version: "0.1.1", uptimeMs: 2000 });

    const fleet = hub.fleetStatus();
    expect(fleet).toHaveLength(2);
    const a = fleet.find((f) => f.node === "n1");
    expect(a?.sessions).toBe(3);
    expect(a?.jobs).toBe(1);
    expect(a?.version).toBe("0.1.1");
    expect(a?.load).toBe(1);
    expect(a?.uptimeMs).toBe(1000);
    const b = fleet.find((f) => f.node === "n2");
    expect(b?.sessions).toBe(5);
    expect(b?.jobs).toBe(0);
    expect(b?.load).toBe(2);
  });
});

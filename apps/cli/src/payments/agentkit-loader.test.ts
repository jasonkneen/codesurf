import { afterEach, describe, expect, it, vi } from "vitest";
import { chainNetworks, type PaymentTerms, termsMismatch } from "./agentkit-loader";

// x402 v2 PaymentRequirements shape (CAIP-2 network, atomic-unit amount).
const approved: PaymentTerms = {
  scheme: "exact",
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "10000",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
};

afterEach(() => {
  vi.doUnmock("@x402/fetch");
  vi.doUnmock("@x402/evm/exact/client");
  vi.resetModules();
});

describe("termsMismatch (H5 pay-time re-check)", () => {
  it("accepts identical terms (address case-insensitive)", () => {
    expect(termsMismatch(approved, { ...approved, payTo: approved.payTo!.toLowerCase() }, "base-sepolia")).toBeNull();
  });

  it("refuses any drift in amount, asset, payTo or network", () => {
    expect(termsMismatch(approved, { ...approved, amount: "10001" }, "base-sepolia")).toMatch(/amount/);
    expect(termsMismatch(approved, { ...approved, asset: "0xdead" }, "base-sepolia")).toMatch(/asset/);
    expect(termsMismatch(approved, { ...approved, payTo: "0xbeef" }, "base-sepolia")).toMatch(/payTo/);
    expect(termsMismatch(approved, { ...approved, network: "eip155:8453" }, "base-sepolia")).toMatch(
      /configured chain/,
    );
  });

  it("maps configured chains to v2 and v1 network ids", () => {
    expect(chainNetworks("base")).toEqual(["eip155:8453", "base"]);
    expect(chainNetworks("base-sepolia")).toEqual(["eip155:84532", "base-sepolia"]);
  });
});

describe("createX402Fetch registration", () => {
  it("registers only the configured network, a terms policy and an abort-on-drift hook", async () => {
    const captured: { config?: Record<string, unknown>; hook?: (ctx: unknown) => Promise<unknown> } = {};
    vi.doMock("@x402/fetch", () => ({
      x402Client: class {
        onBeforePaymentCreation(hook: (ctx: unknown) => Promise<unknown>) {
          captured.hook = hook;
          return this;
        }
      },
      wrapFetchWithPayment: (f: typeof fetch) => f,
    }));
    vi.doMock("@x402/evm/exact/client", () => ({
      registerExactEvmScheme: (_client: unknown, config: Record<string, unknown>) => {
        captured.config = config;
      },
    }));
    const { createX402Fetch } = await import("./agentkit-loader");
    const paid: PaymentTerms[] = [];
    await createX402Fetch(`0x${"1".repeat(64)}`, "base-sepolia", approved, (t) => paid.push(t));

    expect(captured.config?.networks).toEqual(["eip155:84532"]);
    const [policy] = captured.config?.policies as Array<(v: number, reqs: PaymentTerms[]) => PaymentTerms[]>;
    const drifted = { ...approved, amount: "99999999" };
    expect(policy(2, [drifted, approved])).toEqual([approved]);
    expect(policy(2, [drifted])).toEqual([]);

    expect(await captured.hook?.({ selectedRequirements: drifted })).toMatchObject({ abort: true });
    expect(paid).toEqual([]);
    expect(await captured.hook?.({ selectedRequirements: approved })).toBeUndefined();
    expect(paid).toEqual([approved]);
  });
});

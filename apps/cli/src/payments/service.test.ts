import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaymentTerms } from "./agentkit-loader";
import type { PaymentAuditRecord, PaymentOption } from "./types";

const originalCodesurfConfigDir = process.env.CODESURF_CONFIG_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  vi.doUnmock("../utils/settings");
  vi.doUnmock("../wallet/manager");
  vi.doUnmock("./agentkit-loader");
  vi.doUnmock("./brin");
  vi.doUnmock("./history");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalCodesurfConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalCodesurfConfigDir;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64");
}

// x402 v2 PaymentRequirements (CAIP-2 network, atomic amount, USDC contract on Base Sepolia).
const SEPOLIA_USDC_TERMS: PaymentTerms = {
  scheme: "exact",
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "10000",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
};
const MAINNET_USDC_TERMS: PaymentTerms = {
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: "10000",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
};

function paymentTermsHeader(accepts: PaymentTerms[]): string {
  return base64Json({
    x402Version: 2,
    resource: { url: "https://merchant.test/paid", description: "paid thing", mimeType: "text/plain" },
    accepts: accepts.map((terms) => ({ ...terms, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } })),
  });
}

async function importServiceWithMocks(options: {
  paidResponse: Response;
  record?: (entry: PaymentAuditRecord) => void;
  accepts?: PaymentTerms[];
  /** Terms the (mocked) x402 client reports signing, i.e. what the pay-time 402 asked for. */
  paidTerms?: PaymentTerms;
  x402Error?: Error;
}) {
  vi.resetModules();
  const recordMock = vi.fn<(entry: PaymentAuditRecord) => void>(options.record ?? (() => {}));
  const accepts = options.accepts ?? [SEPOLIA_USDC_TERMS];
  let onPaying: ((terms: PaymentTerms) => void) | undefined;
  let approvedTerms: PaymentTerms | undefined;
  const x402Fetch = vi.fn(async () => {
    if (options.x402Error) throw options.x402Error;
    onPaying?.(options.paidTerms ?? approvedTerms!);
    return options.paidResponse;
  });
  const createX402Fetch = vi.fn(
    async (_key: string, _chain: string, approved: PaymentOption, paying?: (terms: PaymentTerms) => void) => {
      onPaying = paying;
      approvedTerms = approved;
      return x402Fetch;
    },
  );
  const fetchMock = vi.fn(async () => {
    return new Response("payment required", {
      status: 402,
      headers: { "payment-required": paymentTermsHeader(accepts) },
    });
  });

  vi.stubGlobal("fetch", fetchMock);
  vi.doMock("../utils/settings", () => ({
    loadPaymentSettings: () => ({
      enabled: true,
      chain: "base-sepolia",
      approval: { autoApprove: true },
    }),
  }));
  vi.doMock("../wallet/manager", () => ({
    WalletManager: class {
      static exists(): boolean {
        return true;
      }

      getStoredWallet(): { privateKey: `0x${string}`; address: string; chain: "base-sepolia"; createdAt: string } {
        return {
          privateKey: `0x${"1".repeat(64)}` as `0x${string}`,
          address: "0xwallet",
          chain: "base-sepolia",
          createdAt: "2026-06-14T00:00:00.000Z",
        };
      }
    },
  }));
  vi.doMock("./brin", () => ({
    scanUrl: vi.fn(async () => null),
  }));
  vi.doMock("./agentkit-loader", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./agentkit-loader")>()),
    createX402Fetch,
  }));
  vi.doMock("./history", () => ({
    PaymentHistory: class {
      static getLogPath(): string {
        return "/tmp/payment_log.jsonl";
      }

      record(entry: PaymentAuditRecord): void {
        recordMock(entry);
      }
    },
  }));

  const { X402Service } = await import("./service");
  return { service: new X402Service(), recordMock, createX402Fetch, x402Fetch };
}

describe("X402Service.paidRequest receipt handling", () => {
  it("surfaces an unparseable proof on a successful payment instead of recording txHash=null", async () => {
    const malformedProof = Buffer.from("{not-json", "utf-8").toString("base64");
    const { service, recordMock } = await importServiceWithMocks({
      paidResponse: new Response("paid body", {
        status: 200,
        headers: { "payment-response": malformedProof },
      }),
    });

    await expect(service.paidRequest({ url: "https://merchant.test/paid" })).rejects.toThrow(
      /Payment already settled on-chain and MUST NOT be retried.*success_unverified/,
    );
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock.mock.calls[0]?.[0]).toMatchObject({
      status: "success_unverified",
      txHash: null,
      rawPaymentResponseHeader: malformedProof,
      paymentProofIssue: "The payment proof header could not be parsed",
      paymentProofError: expect.any(String),
    });
  });

  it("records a settled payment without a proof header as success_unverified", async () => {
    const { service, recordMock } = await importServiceWithMocks({
      paidResponse: new Response("paid body", {
        status: 200,
      }),
    });

    await expect(service.paidRequest({ url: "https://merchant.test/paid" })).rejects.toThrow(
      /Payment already settled on-chain and MUST NOT be retried.*success_unverified/,
    );
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock.mock.calls[0]?.[0]).toMatchObject({
      status: "success_unverified",
      txHash: null,
      rawPaymentResponseHeader: null,
      paymentProofIssue: "No payment proof header was returned",
    });
  });

  it("surfaces receipt write failures after a successful payment with transaction context", async () => {
    const { service, recordMock } = await importServiceWithMocks({
      paidResponse: new Response("paid body", {
        status: 200,
        headers: { "payment-response": base64Json({ transaction: "0xabc123" }) },
      }),
      record: () => {
        throw new Error("disk full");
      },
    });

    await expect(service.paidRequest({ url: "https://merchant.test/paid" })).rejects.toThrow(
      /Payment already settled on-chain and MUST NOT be retried, but the receipt could not be persisted .*tx=0xabc123.*disk full/,
    );
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock.mock.calls[0]?.[0]).toMatchObject({
      status: "success",
      txHash: "0xabc123",
    });
  });
});

describe("X402Service.paidRequest terms policy (H5)", () => {
  const settled = () =>
    new Response("paid body", { status: 200, headers: { "payment-response": base64Json({ transaction: "0xabc" }) } });

  it("pays only an option on the configured chain and pins x402 to those approved terms", async () => {
    const { service, createX402Fetch, recordMock } = await importServiceWithMocks({
      paidResponse: settled(),
      accepts: [MAINNET_USDC_TERMS, SEPOLIA_USDC_TERMS],
    });
    const result = await service.paidRequest({ url: "https://merchant.test/paid" });
    expect(result.success).toBe(true);
    expect(createX402Fetch).toHaveBeenCalledTimes(1);
    const [, chain, approved] = createX402Fetch.mock.calls[0]!;
    expect(chain).toBe("base-sepolia");
    expect(approved).toMatchObject(SEPOLIA_USDC_TERMS);
    expect(recordMock.mock.calls[0]?.[0]).toMatchObject({ status: "success", network: "eip155:84532" });
  });

  it("refuses without paying when no option is on the configured chain", async () => {
    const { service, createX402Fetch } = await importServiceWithMocks({
      paidResponse: settled(),
      accepts: [MAINNET_USDC_TERMS],
    });
    const result = await service.paidRequest({ url: "https://merchant.test/paid" });
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/no payment option on the configured network/);
    expect(createX402Fetch).not.toHaveBeenCalled();
  });

  it("audit-logs the terms actually signed, not the probed ones", async () => {
    const { service, recordMock } = await importServiceWithMocks({
      paidResponse: settled(),
      paidTerms: { ...SEPOLIA_USDC_TERMS, payTo: "0x1111111111111111111111111111111111111111" },
    });
    await service.paidRequest({ url: "https://merchant.test/paid" });
    expect(recordMock.mock.calls[0]?.[0]).toMatchObject({
      status: "success",
      payTo: "0x1111111111111111111111111111111111111111",
    });
  });

  it("reports a pay-time terms refusal as unpaid and audits it", async () => {
    const { service, recordMock } = await importServiceWithMocks({
      paidResponse: settled(),
      x402Error: new Error("All payment requirements were filtered out by policies for x402 version: 2"),
    });
    const result = await service.paidRequest({ url: "https://merchant.test/paid" });
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/nothing was paid/);
    expect(recordMock.mock.calls[0]?.[0]).toMatchObject({ status: "failed", txHash: null });
  });
});

describe("PaymentHistory", () => {
  it("stores receipts in the Codesurf config directory", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-payment-history-test-"));
    tempDirs.push(tempDir);
    process.env.CODESURF_CONFIG_DIR = tempDir;
    vi.resetModules();
    vi.doUnmock("./history");

    const { PaymentHistory } = await import("./history");
    const logPath = path.join(tempDir, "payment_log.jsonl");
    expect(PaymentHistory.getLogPath()).toBe(logPath);

    new PaymentHistory().record({
      id: "receipt-1",
      sessionId: null,
      url: "https://merchant.test/paid",
      domain: "merchant.test",
      method: "GET",
      chain: "base-sepolia",
      network: "base-sepolia",
      asset: "USDC",
      amount: "0.01",
      txHash: "0xabc123",
      status: "success",
      createdAt: "2026-06-14T00:00:00.000Z",
    });

    expect(fs.readFileSync(logPath, "utf-8")).toContain('"txHash":"0xabc123"');
  });
});

describe("X402Service.paidRequest expectedTerms (approval binding)", () => {
  const settled = () =>
    new Response("paid body", { status: 200, headers: { "payment-response": base64Json({ transaction: "0xabc" }) } });

  it("refuses without signing when the server's terms differ from the approved ones", async () => {
    const { service, createX402Fetch, recordMock } = await importServiceWithMocks({ paidResponse: settled() });
    const result = await service.paidRequest({ url: "https://merchant.test/paid" }, undefined, {
      expectedTerms: { ...SEPOLIA_USDC_TERMS, amount: "5000" },
    });
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/terms changed since you approved them/);
    expect(createX402Fetch).not.toHaveBeenCalled();
    expect(recordMock.mock.calls[0]?.[0]).toMatchObject({ status: "failed", txHash: null });
  });

  it("pays when the server's terms match the approved ones", async () => {
    const { service } = await importServiceWithMocks({ paidResponse: settled() });
    const result = await service.paidRequest({ url: "https://merchant.test/paid" }, undefined, {
      expectedTerms: { ...SEPOLIA_USDC_TERMS },
    });
    expect(result.success).toBe(true);
  });
});

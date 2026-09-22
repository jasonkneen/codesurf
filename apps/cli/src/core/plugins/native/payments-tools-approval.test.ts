// paid_request approval is bound to the payment terms the user saw.
//
// Approval used to be granted before anything was known about the payment, so
// "approve" meant "pay whatever the server asks". `needsApproval` now quotes the
// endpoint's terms first (amount, asset, network, payTo) and `execute` hands
// that quote to the service as `expectedTerms`, which refuses to sign on drift.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentInspectionResult } from "../../../payments/types";
import { __resetPluginsForTests, bootstrapPlugins, getRegistrySnapshot } from "../index";
import { createNativePluginModule } from "./host";
import { formatPaidRequestQuote, getPaidRequestApprovalQuote, paymentsToolsPlugin } from "./payments-tools";

const payments = vi.hoisted(() => ({
  inspections: [] as PaymentInspectionResult[],
  paidRequest: vi.fn(async () => ({ success: true, output: "paid content" })),
}));

vi.mock("../../../payments/service", () => ({
  X402Service: class {
    async fetchPaymentInfo() {
      const next = payments.inspections.shift();
      if (!next) throw new Error("no more inspections queued");
      return next;
    }
    paidRequest = payments.paidRequest;
  },
}));

vi.mock("../../../utils/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/settings")>();
  return {
    ...actual,
    loadPaymentSettings: () => ({ enabled: true, chain: "base-sepolia", approval: { autoApprove: false } }),
  };
});

const URL_UNDER_TEST = "https://paid.example.com/data";

function quoted(payTo: string, amount = "10000"): PaymentInspectionResult {
  return {
    requiresPayment: true,
    url: URL_UNDER_TEST,
    method: "GET",
    status: 402,
    options: [
      { scheme: "exact", network: "eip155:1", asset: "0xmainnet", amount: "1", payTo: "0xother" },
      { scheme: "exact", network: "eip155:84532", asset: "0xusdc", amount, payTo },
    ],
  };
}

type PaidRequestTool = {
  needsApproval: (input: unknown, options: unknown) => Promise<boolean>;
  execute: (input: unknown, options?: unknown) => Promise<{ success: boolean; output: string }>;
};

async function paidRequestTool(): Promise<PaidRequestTool> {
  await bootstrapPlugins([createNativePluginModule(paymentsToolsPlugin)]);
  return getRegistrySnapshot().tools.find((t) => t.name === "paid_request")!.tool as unknown as PaidRequestTool;
}

beforeEach(() => {
  __resetPluginsForTests();
  payments.inspections.length = 0;
  payments.paidRequest.mockClear();
});

afterEach(() => {
  __resetPluginsForTests();
});

describe("paid_request approval", () => {
  it("quotes amount, asset, network and payTo on the configured chain before asking", async () => {
    const tool = await paidRequestTool();
    payments.inspections.push(quoted("0xrecipient"));

    const input = { url: URL_UNDER_TEST };
    expect(await tool.needsApproval(input, { toolCallId: "c1", messages: [] })).toBe(true);

    const quote = getPaidRequestApprovalQuote(input);
    expect(quote).toMatchObject({
      kind: "payment",
      option: { network: "eip155:84532", asset: "0xusdc", amount: "10000", payTo: "0xrecipient" },
    });
    const text = formatPaidRequestQuote(quote!);
    expect(text).toContain("Amount: 10000");
    expect(text).toContain("Asset: 0xusdc");
    expect(text).toContain("Network: eip155:84532");
    expect(text).toContain("Pay to: 0xrecipient");
  });

  it("pays only the approved terms", async () => {
    const tool = await paidRequestTool();
    payments.inspections.push(quoted("0xrecipient"));
    const input = { url: URL_UNDER_TEST };
    await tool.needsApproval(input, { toolCallId: "c1", messages: [] });

    const result = await tool.execute(input, { toolCallId: "c1", messages: [] });

    expect(result).toEqual({ success: true, output: "paid content" });
    // The service refuses to sign if the server's terms at pay time differ.
    expect(payments.paidRequest).toHaveBeenCalledWith({ url: URL_UNDER_TEST }, undefined, {
      expectedTerms: {
        scheme: "exact",
        network: "eip155:84532",
        asset: "0xusdc",
        amount: "10000",
        payTo: "0xrecipient",
      },
    });
  });

  it("refuses when a request approved as free now asks for payment", async () => {
    const tool = await paidRequestTool();
    payments.inspections.push(
      { requiresPayment: false, url: URL_UNDER_TEST, method: "GET", status: 200, options: [] },
      quoted("0xrecipient"),
    );
    const input = { url: URL_UNDER_TEST };
    await tool.needsApproval(input, { toolCallId: "c1", messages: [] });

    const result = await tool.execute(input, { toolCallId: "c1", messages: [] });

    expect(result.success).toBe(false);
    expect(result.output).toContain("now does");
    expect(payments.paidRequest).not.toHaveBeenCalled();
  });

  it("refuses when no terms were quoted at approval", async () => {
    const tool = await paidRequestTool();
    const result = await tool.execute({ url: URL_UNDER_TEST }, { toolCallId: "c1", messages: [] });

    expect(result.success).toBe(false);
    expect(result.output).toContain("could not be confirmed");
    expect(payments.paidRequest).not.toHaveBeenCalled();
  });
});

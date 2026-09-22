import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatPaymentApprovalDetail } from "./payment-approval-detail";

describe("formatPaymentApprovalDetail", () => {
  it("shows amount, asset, network and the recipient", () => {
    expect(formatPaymentApprovalDetail({ amount: "0.01", asset: "USDC", network: "base", payTo: "0xabc123" })).toBe(
      "0.01 USDC on base → 0xabc123",
    );
  });

  it("uses the quoted asset instead of assuming USDC", () => {
    expect(formatPaymentApprovalDetail({ amount: "1", asset: "EURC", network: "base", payTo: "0x1" })).toContain(
      "1 EURC",
    );
  });

  it("never hides that the recipient is unknown", () => {
    expect(formatPaymentApprovalDetail({ amount: "1", asset: "", network: "", payTo: "" })).toBe(
      "1 USDC on unknown network → unknown recipient",
    );
    expect(formatPaymentApprovalDetail({ amount: "", asset: "", network: "base", payTo: "0x9" })).toBe(
      "Payment on base → 0x9",
    );
  });
});

describe("payment approval wiring", () => {
  it("carries payTo from the precheck and renders it in the approval card", () => {
    const engine = readFileSync(fileURLToPath(new URL("./hooks/use-turn-engine.ts", import.meta.url)), "utf8");
    const route = readFileSync(fileURLToPath(new URL("./routes/session-route.tsx", import.meta.url)), "utf8");
    expect(engine).toContain('payTo: pc?.payTo ?? "",');
    expect(route).toContain("detail: formatPaymentApprovalDetail(pendingPaymentApproval),");
  });
});

import { loadPaymentSettings } from "../utils/settings";
import { WalletManager } from "../wallet/manager";
import { chainNetworks, createX402Fetch, type PaymentTerms, termsAmount, termsMismatch } from "./agentkit-loader";
import { type BrinScanResult, scanUrl } from "./brin";
import { PaymentHistory } from "./history";
import type { PaymentAuditRecord, PaymentInspectionResult, PaymentOption } from "./types";

interface RequestArgs {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: string;
}

interface PaidRequestArgs extends RequestArgs {}

export interface PaidRequestOptions {
  /** Terms the user approved (paid_request approval). The payment is refused if the server's terms differ. */
  expectedTerms?: PaymentOption;
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function getAmountLabel(option: PaymentOption): string {
  return option.amount ?? option.maxAmountRequired ?? option.price ?? "0";
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parsePaymentResponseTxHash(header: string): string | null {
  const proof = JSON.parse(Buffer.from(header, "base64").toString("utf-8")) as Record<string, unknown>;
  const txHash = proof.transaction ?? proof.txHash ?? proof.tx_hash ?? proof.hash;
  return typeof txHash === "string" && txHash.trim().length > 0 ? txHash : null;
}

function parsePaymentTerms(response: Response): {
  accepts: PaymentOption[];
  description?: string;
} | null {
  const header = response.headers.get("payment-required");
  if (header) {
    try {
      const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
      return {
        accepts: decoded.accepts ?? [],
        description: decoded.resource?.description ?? decoded.description,
      };
    } catch {
      // fall through
    }
  }
  return null;
}

export class X402Service {
  private readonly settings = loadPaymentSettings();
  private readonly walletManager = new WalletManager();
  private readonly history = new PaymentHistory();

  private ensureEnabled(): void {
    if (!this.settings.enabled) {
      throw new Error("Payments are disabled. Enable them in ~/.codesurf/user-settings.json.");
    }
    if (!WalletManager.exists()) {
      throw new Error("No wallet found. Run `grok wallet init` first.");
    }
  }

  async fetchPaymentInfo(args: RequestArgs): Promise<PaymentInspectionResult> {
    this.ensureEnabled();
    const method = args.method ?? "GET";

    const brin = await scanUrl(args.url);

    const response = await fetch(args.url, {
      method,
      headers: args.headers,
      body: method !== "GET" ? args.body : undefined,
    });

    if (response.status !== 402) {
      const data = await response.text();
      return {
        requiresPayment: false,
        url: args.url,
        method,
        status: response.status,
        options: [],
        data,
        brin,
      };
    }

    const terms = parsePaymentTerms(response);
    return {
      requiresPayment: true,
      url: args.url,
      method,
      status: 402,
      options: terms?.accepts ?? [],
      description: terms?.description,
      brin,
    };
  }

  async paidRequest(
    args: PaidRequestArgs,
    sessionId?: string,
    requestOptions: PaidRequestOptions = {},
  ): Promise<{ success: boolean; output: string }> {
    this.ensureEnabled();
    const method = args.method ?? "GET";

    const brin = await scanUrl(args.url);
    if (brin && brin.score < 25) {
      const threatLines = (brin.threats ?? []).map((t) => `  [${t.severity}] ${t.type}: ${t.detail}`);
      this.history.record({
        id: crypto.randomUUID(),
        sessionId: sessionId ?? null,
        url: args.url,
        domain: getDomain(args.url),
        method,
        chain: this.settings.chain,
        network: "n/a",
        asset: "n/a",
        amount: "0",
        txHash: null,
        status: "blocked_by_brin",
        createdAt: new Date().toISOString(),
      });
      return {
        success: false,
        output: [
          `Payment BLOCKED — brin scored this URL ${brin.score}/100 (${brin.verdict}).`,
          `Domain: ${getDomain(args.url)}`,
          ...(threatLines.length > 0 ? ["Threats detected:", ...threatLines] : []),
          "",
          "This URL is considered unsafe. The transaction was not signed.",
        ].join("\n"),
      };
    }

    const probeResponse = await fetch(args.url, {
      method,
      headers: args.headers,
      body: method !== "GET" ? args.body : undefined,
    });

    if (probeResponse.status !== 402) {
      return { success: true, output: await probeResponse.text() };
    }

    const terms = parsePaymentTerms(probeResponse);
    const options = terms?.accepts ?? [];
    if (options.length === 0) {
      return {
        success: false,
        output: "Server returned 402 but no payment options were found.",
      };
    }

    const stored = this.walletManager.getStoredWallet();
    // Only ever pay on the configured chain; the wallet is bound to its chain.
    const chain = stored.chain;
    if (this.settings.chain && this.settings.chain !== chain) {
      return {
        success: false,
        output: `Payment refused: payments are configured for ${this.settings.chain} but the wallet is on ${chain}.`,
      };
    }
    const selected = options.find((option) => chainNetworks(chain).includes(option.network));
    if (!selected) {
      return {
        success: false,
        output: `Payment refused: the server offers no payment option on the configured network (${chain}). Offered: ${options
          .map((option) => option.network)
          .join(", ")}.`,
      };
    }

    const expected = requestOptions.expectedTerms;
    const drift = expected ? termsMismatch(expected, selected, chain) : null;
    if (expected && drift) {
      const describe = (o: PaymentOption) => `${getAmountLabel(o)} ${o.asset} on ${o.network} -> ${o.payTo ?? "?"}`;
      this.history.record({
        id: crypto.randomUUID(),
        sessionId: sessionId ?? null,
        url: args.url,
        domain: getDomain(args.url),
        method,
        chain,
        network: selected.network,
        asset: selected.asset,
        amount: getAmountLabel(selected),
        ...(selected.payTo ? { payTo: selected.payTo } : {}),
        txHash: null,
        status: "failed",
        paymentProofIssue: `not paid: terms changed since approval (${drift})`,
        createdAt: new Date().toISOString(),
      });
      return {
        success: false,
        output: `Payment refused: the server's terms changed since you approved them (approved ${describe(expected)}, now ${describe(selected)}).`,
      };
    }

    // The paid request re-fetches the 402; x402 pays only terms identical to
    // `selected` (the terms inspected here) and reports what it actually signs.
    let paidTerms: PaymentTerms | undefined;
    const x402Fetch = await createX402Fetch(stored.privateKey, chain, selected, (terms) => {
      paidTerms = terms;
    });

    let paidResponse: Response;
    try {
      paidResponse = await x402Fetch(args.url, {
        method,
        headers: args.headers,
        body: method !== "GET" ? args.body : undefined,
      });
    } catch (err: unknown) {
      // Nothing was signed yet (terms drifted, or the request failed before
      // payment creation): safe to report as a refused, unpaid request.
      if (paidTerms) throw err;
      this.history.record({
        id: crypto.randomUUID(),
        sessionId: sessionId ?? null,
        url: args.url,
        domain: getDomain(args.url),
        method,
        chain,
        network: selected.network,
        asset: selected.asset,
        amount: getAmountLabel(selected),
        txHash: null,
        status: "failed",
        paymentProofIssue: `not paid: ${getErrorMessage(err)}`,
        createdAt: new Date().toISOString(),
      });
      return { success: false, output: `Payment refused, nothing was paid: ${getErrorMessage(err)}` };
    }

    // Audit what was actually signed, not what the probe showed.
    const actual = paidTerms ?? selected;
    const amount = termsAmount(actual) || getAmountLabel(selected);

    const responseText = await paidResponse.text();
    const success = paidResponse.ok;

    const paymentResponseHeader =
      paidResponse.headers.get("payment-response") ?? paidResponse.headers.get("x-payment-response");
    let txHash: string | null = null;

    const receiptContext = `${method} ${args.url}, ${amount} ${actual.asset} on ${actual.network}`;
    const buildAuditRecord = (
      status: PaymentAuditRecord["status"],
      extras: Partial<PaymentAuditRecord> = {},
    ): PaymentAuditRecord => ({
      id: crypto.randomUUID(),
      sessionId: sessionId ?? null,
      url: args.url,
      domain: getDomain(args.url),
      method,
      chain: this.settings.chain,
      network: actual.network,
      asset: actual.asset,
      amount,
      ...(actual.payTo ? { payTo: actual.payTo } : {}),
      txHash,
      status,
      createdAt: new Date().toISOString(),
      ...extras,
    });

    const recordAudit = (auditRecord: PaymentAuditRecord, failureMessage: string): void => {
      try {
        this.history.record(auditRecord);
      } catch (err: unknown) {
        throw new Error(`${failureMessage} Original error: ${getErrorMessage(err)}`, { cause: err });
      }
    };

    const recordAnomalousSuccessAndThrow = (issue: string, proofError?: string): never => {
      recordAudit(
        buildAuditRecord("success_unverified", {
          rawPaymentResponseHeader: paymentResponseHeader ?? null,
          paymentProofIssue: issue,
          ...(proofError ? { paymentProofError: proofError } : {}),
        }),
        `Payment already settled on-chain and MUST NOT be retried, but the anomalous payment receipt could not be persisted (${receiptContext}; proof issue: ${issue}).`,
      );
      throw new Error(
        `Payment already settled on-chain and MUST NOT be retried. ${issue}. Receipt was recorded as success_unverified, not as a clean success with txHash:null.`,
      );
    };

    if (paymentResponseHeader) {
      try {
        txHash = parsePaymentResponseTxHash(paymentResponseHeader);
      } catch (err: unknown) {
        if (success) {
          recordAnomalousSuccessAndThrow("The payment proof header could not be parsed", getErrorMessage(err));
        }
      }
    }

    if (success && !paymentResponseHeader) {
      recordAnomalousSuccessAndThrow("No payment proof header was returned");
    }

    if (success && !txHash) {
      recordAnomalousSuccessAndThrow("The payment proof did not include a transaction hash");
    }

    const auditRecord = buildAuditRecord(success ? "success" : "failed");
    const txPart = txHash ? ` tx=${txHash}` : "";
    recordAudit(
      auditRecord,
      success
        ? `Payment already settled on-chain and MUST NOT be retried, but the receipt could not be persisted (${receiptContext}${txPart}).`
        : `Payment completed but the receipt could not be persisted (${receiptContext}${txPart}).`,
    );

    const lines = [responseText];
    if (txHash) {
      lines.push(`\nTransaction: ${txHash}`);
    }

    return { success, output: lines.join("") };
  }
}

function formatBrinLines(brin: BrinScanResult): string[] {
  const lines: string[] = [`Security: ${brin.score}/100 (${brin.verdict}, ${brin.confidence} confidence)`];

  if (brin.subScores) {
    const parts: string[] = [];
    if (brin.subScores.identity !== null) parts.push(`Identity: ${brin.subScores.identity}`);
    if (brin.subScores.behavior !== null) parts.push(`Behavior: ${brin.subScores.behavior}`);
    if (brin.subScores.content !== null) parts.push(`Content: ${brin.subScores.content}`);
    if (brin.subScores.graph !== null) parts.push(`Graph: ${brin.subScores.graph}`);
    if (parts.length > 0) lines.push(`  ${parts.join(" | ")}`);
  }

  if (brin.threats && brin.threats.length > 0) {
    for (const t of brin.threats) {
      lines.push(`  [${t.severity}] ${t.type}: ${t.detail}`);
    }
  }

  return lines;
}

export function formatInspectionOutput(inspection: PaymentInspectionResult): string {
  if (!inspection.requiresPayment) {
    const base = typeof inspection.data === "string" ? inspection.data : JSON.stringify(inspection.data ?? {});
    if (inspection.brin) {
      return [base, "", ...formatBrinLines(inspection.brin)].join("\n");
    }
    return base;
  }
  const lines = inspection.options.map((option, i) => {
    const amount = getAmountLabel(option);
    return `${i + 1}. ${amount} via ${option.network} (${option.asset})${option.payTo ? ` -> ${option.payTo}` : ""}`;
  });
  return [
    "Payment required (402).",
    ...(inspection.description ? [`Description: ${inspection.description}`] : []),
    ...lines,
    ...(inspection.brin ? ["", ...formatBrinLines(inspection.brin)] : []),
  ].join("\n");
}

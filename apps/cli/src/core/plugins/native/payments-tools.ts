// Kernel-owned wallet & payments tools.
//
// Phase 2 step 2: takes 4 tools out of `createTools()` in `src/grok/tools.ts`
// and into a kernel extension that owns the full ai-sdk `tool({...})` defs:
//
//   - wallet_info          (read local wallet balance)
//   - wallet_history       (list recent x402 payment attempts)
//   - fetch_payment_info   (inspect a URL for x402 payment requirements)
//   - paid_request         (make an x402-paid HTTP request — needsApproval)
//
// Host coupling:
//
//   - `paid_request` needs the active session id so each payment is logged
//     against the right transcript. Pulled lazily via
//     `services.session.id()` at execute time (added in this same step —
//     see `loader.ts`/`api.ts`). Returns `null` for headless/boot-only
//     contexts; that's fine — `service.paidRequest()` accepts an optional
//     sessionId.
//
//   - `paid_request.needsApproval` reads `loadPaymentSettings()` from
//     `utils/settings`; that's already a side-effect-free disk read and
//     doesn't need a host-service primitive.
//
// Group: keeps the existing `"payments"` group string the metadata-only
// extension used in `groups.ts` so user toggles via
// `services.tools.setEnabled(...)` and `/extensions` filters continue to
// work unchanged.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { tool } from "ai";
import { z } from "zod";
import type { PaymentOption } from "../../../payments/types";
import { loadPaymentSettings } from "../../../utils/settings";

type PaidRequestInput = {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: string;
};

/** What the user is asked to approve: the payment the server named, or none. */
export type PaidRequestQuote =
  | { kind: "payment"; option: PaymentOption; description?: string }
  | { kind: "free" }
  | { kind: "unavailable"; reason: string };

/** How long approval waits on the endpoint for its terms. */
const QUOTE_TIMEOUT_MS = 10_000;

/**
 * Terms quoted at approval time, keyed by the call's input.
 *
 * ai-sdk evaluates `needsApproval` and `execute` on the same input, so the
 * input is the join key between what the user saw and what gets paid. An
 * entry is consumed by the execute it approved.
 */
const approvedQuotes = new Map<string, PaidRequestQuote>();

function quoteKey(input: PaidRequestInput): string {
  return JSON.stringify([input.url, input.method ?? "GET", input.headers ?? {}, input.body ?? null]);
}

/**
 * Ask the endpoint for its x402 terms and pick the option on the configured
 * chain — the same selection `X402Service.paidRequest` makes.
 */
async function quotePaidRequest(input: PaidRequestInput): Promise<PaidRequestQuote> {
  try {
    const [{ X402Service }, { chainNetworks }] = await Promise.all([
      import("../../../payments/service"),
      import("../../../payments/agentkit-loader"),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inspection = await Promise.race([
      new X402Service().fetchPaymentInfo(input),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out fetching payment terms")), QUOTE_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if (!inspection.requiresPayment) return { kind: "free" };
    const chain = loadPaymentSettings().chain;
    const option = inspection.options.find((candidate) => chainNetworks(chain).includes(candidate.network));
    if (!option) {
      return {
        kind: "unavailable",
        reason: `no payment option on the configured network (${chain}); offered: ${
          inspection.options.map((candidate) => candidate.network).join(", ") || "none"
        }`,
      };
    }
    return { kind: "payment", option, description: inspection.description };
  } catch (err: unknown) {
    return { kind: "unavailable", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** One line per term, for the approval prompt and refusals. */
export function formatPaidRequestQuote(quote: PaidRequestQuote): string {
  if (quote.kind === "free") return "No payment requested (the endpoint did not return 402).";
  if (quote.kind === "unavailable") return `Payment terms unavailable: ${quote.reason}`;
  const { option } = quote;
  return [
    `Amount: ${option.amount ?? option.maxAmountRequired ?? option.price ?? "unknown"}`,
    `Asset: ${option.asset}`,
    `Network: ${option.network}`,
    `Pay to: ${option.payTo ?? "unknown"}`,
  ].join("\n");
}

/**
 * The terms a pending `paid_request` approval was quoted, for the approval UI
 * to display. Does not consume the entry.
 */
export function getPaidRequestApprovalQuote(input: PaidRequestInput): PaidRequestQuote | undefined {
  return approvedQuotes.get(quoteKey(input));
}

const manifest: PluginManifest = {
  id: "builtin.tools.payments",
  name: "Wallet & Payments",
  version: "1.0.0",
  description: "x402 wallet info, payment history, quotes, and paid HTTP requests.",
  enabledByDefault: true,
  capabilities: ["tools", "commands"],
};

export const paymentsToolsPlugin: CodesurfPlugin = {
  name: "codesurf-payments-tools",
  manifest,
  inject: ["contributions", "tools", "session", "ui"],
  apply(ctx: PluginContext) {
    // /wallet slash command — registered here so it disappears from the
    // slash menu and Ctrl+K palette when this extension is disabled. The
    // wallet picker screen itself stays registered (and protected) by
    // builtin.screens.wallet so other entry points still resolve it.
    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/wallet",
        description: "Open the wallet picker.",
        handler: () => ctx.ui.action({ type: "wallet" }),
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "wallet_info",
        description: "Show wallet address and balances.",
        group: "payments",
        tool: tool({
          description:
            "Get the local wallet address, chain, and current balances (ETH and USDC). Use this to check available funds before making a payment.",
          inputSchema: z.object({}),
          execute: async () => {
            try {
              const { WalletManager } = await import("../../../wallet/manager");
              if (!WalletManager.exists()) {
                return { success: false, output: "No wallet found. Run `grok wallet init` to create one." };
              }
              const wm = new WalletManager();
              const balance = await wm.getBalance();
              return {
                success: true,
                output: [
                  `Address: ${balance.address}`,
                  `Chain: ${balance.chain}`,
                  `ETH: ${balance.nativeBalance}`,
                  `USDC: ${balance.usdcBalance}`,
                ].join("\n"),
              };
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return { success: false, output: `Failed to get wallet info: ${msg}` };
            }
          },
        }),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "wallet_history",
        description: "Show recent payment attempts.",
        group: "payments",
        tool: tool({
          description:
            "Show recent x402 payment history from the local audit log. Returns the most recent payment attempts with status, URL, amount, and transaction hash.",
          inputSchema: z.object({
            limit: z.number().optional().describe("Number of recent entries to return (default: 10)"),
          }),
          execute: async ({ limit }) => {
            try {
              const { PaymentHistory } = await import("../../../payments/history");
              const history = new PaymentHistory();
              const entries = history.list(limit ?? 10);
              if (entries.length === 0) {
                return { success: true, output: "No payment history yet." };
              }
              const lines = entries.map((e) => {
                const parts = [
                  `${e.createdAt}  ${e.status}`,
                  `  ${e.method} ${e.url}`,
                  `  ${e.amount} ${e.asset} on ${e.network}`,
                ];
                if (e.txHash) parts.push(`  tx: ${e.txHash}`);
                return parts.join("\n");
              });
              return { success: true, output: lines.join("\n\n") };
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return { success: false, output: `Failed to read payment history: ${msg}` };
            }
          },
        }),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "fetch_payment_info",
        description: "Inspect an x402 endpoint's payment requirements.",
        group: "payments",
        tool: tool({
          description:
            "Inspect a URL for x402 payment requirements without paying. Returns payment options and a brin security scan with score, sub-scores (identity, behavior, content, graph), and any detected threats. Use this only when the user wants to inspect without paying — for actual access, call paid_request directly instead.",
          inputSchema: z.object({
            url: z.string().url().describe("The URL to inspect"),
            method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional().describe("HTTP method (default: GET)"),
            headers: z.record(z.string(), z.string()).optional().describe("Optional HTTP headers"),
            body: z.string().optional().describe("Optional request body for POST/PUT/PATCH"),
          }),
          execute: async ({ url, method, headers, body }) => {
            try {
              const { X402Service, formatInspectionOutput } = await import("../../../payments/service");
              const service = new X402Service();
              const inspection = await service.fetchPaymentInfo({ url, method, headers, body });
              return {
                success: true,
                output: formatInspectionOutput(inspection),
              };
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return {
                success: false,
                output: `Failed to inspect payment info: ${msg}`,
              };
            }
          },
        }),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "paid_request",
        description: "Make an x402-paid HTTP request to a protected endpoint.",
        group: "payments",
        modes: ["agent"],
        tool: tool({
          description:
            "Access an x402-protected URL using the local wallet. URLs scoring below 25 on brin are automatically blocked. The user will be prompted to approve the payment before it executes.",
          inputSchema: z.object({
            url: z.string().url().describe("The URL to access"),
            method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional().describe("HTTP method (default: GET)"),
            headers: z.record(z.string(), z.string()).optional().describe("Optional HTTP headers"),
            body: z.string().optional().describe("Optional request body for POST/PUT/PATCH"),
          }),
          // Quote the terms BEFORE asking, so the approval is for a specific
          // amount, asset, network and recipient — and execute pays only that.
          needsApproval: async (input: PaidRequestInput) => {
            let autoApprove = false;
            try {
              autoApprove = loadPaymentSettings().approval.autoApprove === true;
            } catch {
              autoApprove = false;
            }
            if (autoApprove) return false;
            if (input?.url) approvedQuotes.set(quoteKey(input), await quotePaidRequest(input));
            return true;
          },
          execute: ctx.tools.wrapExecute<PaidRequestInput>("paid_request", async (input) =>
            ctx.tools.safeExecute({
              label: "access paid URL",
              fn: async () => {
                const { url, method, headers, body } = input;
                const key = quoteKey(input);
                const approved = approvedQuotes.get(key);
                approvedQuotes.delete(key);
                let autoApprove = false;
                try {
                  autoApprove = loadPaymentSettings().approval.autoApprove === true;
                } catch {
                  autoApprove = false;
                }
                const sessionId = ctx.session.id() ?? undefined;
                if (!autoApprove) {
                  // The user approved specific terms (or none); pay only those.
                  if (!approved || approved.kind === "unavailable") {
                    return {
                      success: false,
                      output: `Payment refused: the terms could not be confirmed when approval was requested.${
                        approved ? `\n${formatPaidRequestQuote(approved)}` : ""
                      }`,
                    };
                  }
                  if (approved.kind === "free") {
                    // Approved as a free request; the service has no "expect no
                    // payment" option, so re-check before it can sign.
                    const current = await quotePaidRequest(input);
                    if (current.kind !== "free") {
                      return {
                        success: false,
                        output: `Payment refused: the endpoint asked for no payment when you approved, and now does.\n${formatPaidRequestQuote(current)}`,
                      };
                    }
                  }
                }
                const { X402Service } = await import("../../../payments/service");
                const service = new X402Service();
                // The service re-probes and refuses to sign if the server's
                // terms differ from these in network, asset, payTo or amount.
                const expectedTerms = approved?.kind === "payment" ? approved.option : undefined;
                return await service.paidRequest({ url, method, headers, body }, sessionId, { expectedTerms });
              },
            }),
          ),
        }),
      }),
    );
  },
};

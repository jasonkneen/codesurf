import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { PaymentChain } from "../utils/settings";
import type { PaymentOption } from "./types";

/** Requirement shape x402 hands to policies/hooks (v2 `amount`, v1 `maxAmountRequired`). */
export interface PaymentTerms {
  scheme: string;
  network: string;
  asset: string;
  payTo?: string;
  amount?: string;
  maxAmountRequired?: string;
  price?: string;
}

function viemChainFor(chain: PaymentChain) {
  return chain === "base" ? base : baseSepolia;
}

/** Network ids (x402 v2 CAIP-2 and the v1 name) that belong to the configured chain. */
export function chainNetworks(chain: PaymentChain): string[] {
  return [`eip155:${viemChainFor(chain).id}`, chain];
}

export function termsAmount(terms: PaymentTerms | PaymentOption): string {
  return terms.amount ?? terms.maxAmountRequired ?? terms.price ?? "";
}

function sameAmount(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
}

/**
 * Why `actual` (what the server asks for at pay time) must not be paid under
 * the `approved` terms (what the probe showed), or null when they match. The
 * paid request re-fetches the 402 itself, so the server gets a second chance
 * to name different terms; any drift in network/asset/payTo/amount refuses.
 */
export function termsMismatch(approved: PaymentOption, actual: PaymentTerms, chain: PaymentChain): string | null {
  if (!chainNetworks(chain).includes(actual.network)) {
    return `network ${actual.network} is not the configured chain (${chain})`;
  }
  if (actual.network !== approved.network) return `network changed: ${approved.network} -> ${actual.network}`;
  if (approved.scheme && actual.scheme !== approved.scheme) {
    return `scheme changed: ${approved.scheme} -> ${actual.scheme}`;
  }
  if (!sameAddress(actual.asset, approved.asset)) return `asset changed: ${approved.asset} -> ${actual.asset}`;
  if (!sameAddress(actual.payTo, approved.payTo)) return `payTo changed: ${approved.payTo} -> ${actual.payTo}`;
  const approvedAmount = termsAmount(approved);
  const actualAmount = termsAmount(actual);
  if (!sameAmount(actualAmount, approvedAmount)) return `amount changed: ${approvedAmount} -> ${actualAmount}`;
  return null;
}

export async function createX402Fetch(
  privateKey: `0x${string}`,
  chain: PaymentChain,
  approved: PaymentOption,
  onPaying?: (terms: PaymentTerms) => void,
): Promise<typeof globalThis.fetch> {
  const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");

  const account = privateKeyToAccount(privateKey);
  const viemChain = viemChainFor(chain);
  const walletClient = createWalletClient({
    account,
    chain: viemChain,
    transport: http(),
  });

  const signer = {
    address: account.address,
    signTypedData: walletClient.signTypedData.bind(walletClient),
    readContract: walletClient.extend(() => ({})),
  };

  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: signer as never,
    // Only the configured chain for v2; v1 schemes are registered for every
    // EVM network regardless, so the policy below is what actually pins it.
    networks: [`eip155:${viemChain.id}`],
    // Max-amount/terms policy: only requirements identical to the approved
    // terms (amount included) survive; none left -> x402 refuses to pay.
    policies: [(_version, requirements) => requirements.filter((r) => termsMismatch(approved, r, chain) === null)],
  });
  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    const mismatch = termsMismatch(approved, selectedRequirements, chain);
    if (mismatch) return { abort: true, reason: `payment terms differ from the approved terms: ${mismatch}` };
    onPaying?.(selectedRequirements);
  });

  return wrapFetchWithPayment(fetch, client) as typeof globalThis.fetch;
}

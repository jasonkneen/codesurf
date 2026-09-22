import type { PaymentChain } from "../utils/settings";
import type { BrinScanResult } from "./brin";

export interface PaymentOption {
  scheme: string;
  network: string;
  asset: string;
  amount?: string;
  maxAmountRequired?: string;
  price?: string;
  payTo?: string;
}

export interface PaymentAuditRecord {
  id: string;
  sessionId: string | null;
  url: string;
  domain: string;
  method: string;
  chain: PaymentChain;
  network: string;
  asset: string;
  amount: string;
  /** Recipient of the payment actually signed. */
  payTo?: string;
  txHash?: string | null;
  status: "success" | "success_unverified" | "failed" | "requires_approval" | "blocked_by_brin";
  rawPaymentResponseHeader?: string | null;
  paymentProofIssue?: string;
  paymentProofError?: string;
  createdAt: string;
}

export interface PaymentInspectionResult {
  requiresPayment: boolean;
  url: string;
  method: string;
  status: number;
  options: PaymentOption[];
  description?: string;
  data?: unknown;
  brin?: BrinScanResult | null;
}

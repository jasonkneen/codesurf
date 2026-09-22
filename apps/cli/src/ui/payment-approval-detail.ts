// One-line summary of what a payment approval will actually do: how much, in
// which asset, on which network, and to whom. The recipient must always be
// visible — approving a payment without seeing where it goes is not consent.

export function formatPaymentApprovalDetail(payment: {
  amount: string;
  asset: string;
  network: string;
  payTo: string;
}): string | undefined {
  if (!payment.amount && !payment.payTo) return undefined;
  const amount = payment.amount ? `${payment.amount} ${payment.asset || "USDC"}` : "Payment";
  const network = payment.network || "unknown network";
  const recipient = payment.payTo || "unknown recipient";
  return `${amount} on ${network} → ${recipient}`;
}

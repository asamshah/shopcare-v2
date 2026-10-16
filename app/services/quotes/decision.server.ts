// STUB(w2-proxy): this module belongs to w2-backend (Repairs::QuoteDecision).
// Integration replaces it with the real service; the signatures below are the
// wave-2 contract the storefront quote page codes against.

export type QuoteDecisionResult = { ok: true } | { ok: false; error: string };

/** The customer (or staff) declines a sent quote, with an optional reason. */
export async function declineQuote(args: {
  shopId: number;
  quotationId: number;
  reason?: string | null;
  by: "customer" | "staff";
}): Promise<QuoteDecisionResult> {
  void args;
  return { ok: false, error: "This quote can't be changed any more." };
}

/** A sent quote left unpaid past its validity expires. */
export async function expireQuote(args: {
  shopId: number;
  quotationId: number;
}): Promise<QuoteDecisionResult> {
  void args;
  return { ok: false, error: "This quote hasn't expired." };
}

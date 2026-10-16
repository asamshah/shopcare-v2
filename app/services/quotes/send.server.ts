// STUB(w2-admin): owned by w2-backend (Rails Repairs::QuoteSender#call). Integration replaces this file.
/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures */
import { type Actor, NOT_PORTED, type Result } from "./result.server";

/** Draft → sent (Shopify emails the invoice); a £0 covered quote completes (`warranty: true`). */
export async function sendQuote(_args: {
  shopId: number;
  quotationId: number;
  actor: Actor;
}): Promise<Result<{ warranty?: boolean }>> {
  return { ok: false, error: NOT_PORTED };
}

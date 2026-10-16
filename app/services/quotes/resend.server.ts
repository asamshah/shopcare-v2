// STUB(w2-admin): owned by w2-backend (Rails Repairs::QuoteSender#resend). Integration replaces this file.
/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures */
import { type Actor, NOT_PORTED, type Result } from "./result.server";

/** Shopify emails the invoice again; an expired quote is reopened with a new draft order. */
export async function resendInvoice(_args: {
  shopId: number;
  quotationId: number;
  actor: Actor;
}): Promise<Result> {
  return { ok: false, error: NOT_PORTED };
}

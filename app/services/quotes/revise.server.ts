// STUB(w2-admin): owned by w2-backend (Rails QuotationsController#revise + QuoteDraftOrder#delete).
/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures */
// Integration replaces this file.
import { type Actor, NOT_PORTED, type Result } from "./result.server";

/** A new draft from the quote; the old draft order is deleted and the ticket goes back to assessing. */
export async function reviseQuote(_args: {
  shopId: number;
  quotationId: number;
  actor: Actor;
}): Promise<Result<{ newQuotationId: number }>> {
  return { ok: false, error: NOT_PORTED };
}

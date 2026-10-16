// STUB(w2-admin): owned by w2-backend (Rails Repairs::QuoteDecision). Integration replaces this file.
/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures */
import { NOT_PORTED, type Result } from "./result.server";

export async function declineQuote(_args: {
  shopId: number;
  quotationId: number;
  reason: string | null;
  by: "customer" | "staff";
}): Promise<Result> {
  return { ok: false, error: NOT_PORTED };
}

/** A sent quote past its validity becomes expired (the admin calls it on view, like Rails). */
export async function expireQuote(_args: { shopId: number; quotationId: number }): Promise<Result> {
  return { ok: false, error: NOT_PORTED };
}

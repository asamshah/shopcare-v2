/**
 * A sent quote that won't be paid (contract service, w2-backend). Port of
 * Repairs::QuoteDecision. The customer can decline it (with an optional
 * reason) from its review page; one left unpaid past its validity expires (no
 * reason). Either way the ticket moves to quote_declined (unless cancelled),
 * the Shopify draft order is deleted so its invoice can't be paid any more,
 * the decision is logged, the `quote_declined` outbound webhook is sent and
 * staff are alerted (quote_declined / quote_expired). Staff can revise the
 * quote and send it again. (Paying the invoice is accepting:
 * processRepairPayment.)
 *
 * The change is made under the quotation's row lock, so a double-click only
 * ever records one decision.
 */
import type { Quotation } from "@prisma/client";
import prisma from "../../db.server";
import { isDecisionOverdue, validUntil } from "../../models/quotation.server";
import { createTicketActivity } from "../../models/ticket-activity.server";
import { deleteQuoteDraftOrder } from "../repairs/quote-draft-order.server";
import { notifyRepairStatusChanged } from "../repairs/ticket-status.server";
import {
  clientFor,
  emitTicketWebhook,
  findShopQuotation,
  withLock,
  type Result,
  type ServiceOptions,
} from "./common.server";
import { notifyQuoteDeclined, notifyQuoteExpired } from "./notifications.server";
import { setTicketStatus } from "./send.server";

export interface DeclineQuoteInput extends ServiceOptions {
  shopId: number;
  quotationId: number;
  reason?: string | null;
  by: "customer" | "staff";
}

export interface ExpireQuoteInput extends ServiceOptions {
  shopId: number;
  quotationId: number;
}

export async function declineQuote({
  shopId,
  quotationId,
  reason,
  by,
  db = prisma,
  now = new Date(),
  ...options
}: DeclineQuoteInput): Promise<Result> {
  const found = await findShopQuotation(db, shopId, quotationId);
  if (!found) return { ok: false, error: "Quote not found." };
  if (isDecisionOverdue(found, now)) {
    await expireQuote({ shopId, quotationId, db, now, ...options });
    return { ok: false, error: "This quote has expired." };
  }
  return close(found.id, "declined", truncate(reason), by, {
    db,
    now,
    ...options,
  });
}

/** A quote left unpaid past its validity: treated like a decline with no reason. */
export async function expireQuote({
  shopId,
  quotationId,
  db = prisma,
  now = new Date(),
  ...options
}: ExpireQuoteInput): Promise<Result> {
  const found = await findShopQuotation(db, shopId, quotationId);
  if (!found) return { ok: false, error: "Quote not found." };
  if (!isDecisionOverdue(found, now))
    return { ok: false, error: "This quote hasn't expired." };
  return close(found.id, "expired", null, "system", { db, now, ...options });
}

/** Rails `reason.to_s.strip.truncate(1000).presence`. */
function truncate(reason: string | null | undefined): string | null {
  const text = (reason ?? "").trim();
  if (!text) return null;
  return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
}

function refusal(quotation: Pick<Quotation, "status">): string {
  switch (quotation.status) {
    case "expired":
      return "This quote has expired.";
    case "paid":
      return "This quote has already been paid.";
    case "declined":
      return "This quote has already been declined.";
    default:
      return "This quote can't be changed any more.";
  }
}

async function close(
  quotationId: number,
  status: "declined" | "expired",
  reason: string | null,
  by: "customer" | "staff" | "system",
  { db = prisma, now = new Date(), ...options }: ServiceOptions,
): Promise<Result> {
  const outcome = await withLock(db, "quotations", quotationId, async (tx) => {
    const quotation = await tx.quotation.findUniqueOrThrow({ where: { id: quotationId } });
    if (quotation.status !== "sent") return { ok: false as const, error: refusal(quotation) };
    const updated = await tx.quotation.update({
      where: { id: quotationId },
      data: { status, decidedAt: now, decidedBy: by, decisionReason: reason },
    });
    const ticket = await tx.repairTicket.findUniqueOrThrow({
      where: { id: quotation.repairTicketId },
    });
    const moved =
      ticket.status === "cancelled"
        ? { ticket, changed: false }
        : await setTicketStatus(tx, ticket.id, "quote_declined");
    return { ok: true as const, quotation: updated, moved };
  });
  if (!outcome.ok) return outcome;

  const { quotation, moved } = outcome;
  const shop = await db.shop.findUniqueOrThrow({ where: { id: moved.ticket.shopId } });
  let body =
    status === "expired"
      ? `Quote expired: not paid by ${validUntil(quotation)}.`
      : "The customer declined the quote.";
  if (reason) body += ` Reason: ${reason}`;
  const deleted = quotation.shopifyDraftOrderId
    ? await deleteQuoteDraftOrder(quotationId, await clientFor(shop, options.client), {
        db,
        logger: options.logger,
      })
    : "";
  await createTicketActivity(
    {
      repairTicketId: moved.ticket.id,
      activityType: "quote_decision",
      author: by,
      body: `${body}${deleted}`,
    },
    db,
  );
  await emitTicketWebhook(
    shop,
    moved.ticket.id,
    "quote_declined",
    status === "expired" ? "expired" : reason,
    options,
  );
  const notifyOptions = { db, deps: options.notifyDeps };
  if (status === "expired") await notifyQuoteExpired(shop, quotation, moved.ticket, notifyOptions);
  else await notifyQuoteDeclined(shop, quotation, moved.ticket, notifyOptions);
  if (moved.changed) await notifyRepairStatusChanged(shop, moved.ticket, notifyOptions);
  return { ok: true };
}

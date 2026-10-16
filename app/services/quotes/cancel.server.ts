/**
 * When a ticket is cancelled, its open quotes (draft, or sent and awaiting
 * payment) are cancelled too: the review link stops working and the Shopify
 * draft order is deleted, so the customer can't pay. Logged on the ticket.
 * Port of Repairs::QuoteCanceller (contract service, w2-backend).
 *
 * Each quote is claimed under its row lock, so a payment arriving at the same
 * moment sees one state or the other (a payment that wins is flagged on the
 * cancelled ticket by the orders/paid handler).
 */
import prisma from "../../db.server";
import { cancelQuotation, isOpen } from "../../models/quotation.server";
import { createTicketActivity } from "../../models/ticket-activity.server";
import { deleteQuoteDraftOrder } from "../repairs/quote-draft-order.server";
import {
  clientFor,
  withLock,
  type Actor,
  type Result,
  type ServiceOptions,
} from "./common.server";

export interface CancelOpenQuotesInput extends ServiceOptions {
  shopId: number;
  ticketId: number;
  actor: Actor;
}

/** `note` is the line for staff (null when there was no open quote). */
export async function cancelOpenQuotesForTicket({
  shopId,
  ticketId,
  db = prisma,
  ...options
}: CancelOpenQuotesInput): Promise<Result<{ cancelled: number[]; note: string | null }>> {
  const ticket = await db.repairTicket.findFirst({
    where: { id: ticketId, shopId },
    include: { shop: true, quotations: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] } },
  });
  if (!ticket) return { ok: false, error: "Ticket not found." };

  const cancelled: number[] = [];
  const notes: string[] = [];
  for (const quotation of ticket.quotations.filter(isOpen)) {
    const claimed = await withLock(db, "quotations", quotation.id, async (tx) => {
      const fresh = await tx.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
      if (!isOpen(fresh)) return false;
      await cancelQuotation(quotation.id, tx);
      return true;
    });
    if (!claimed) continue;
    cancelled.push(quotation.id);
    const deleted = quotation.shopifyDraftOrderId
      ? await deleteQuoteDraftOrder(
          quotation.id,
          await clientFor(ticket.shop, options.client),
          { db, logger: options.logger },
        )
      : "";
    const body = `Quote cancelled with the ticket.${deleted}`;
    await createTicketActivity(
      { repairTicketId: ticketId, activityType: "system", author: "system", body },
      db,
    );
    notes.push(body);
  }
  return { ok: true, cancelled, note: notes.length ? notes.join(" ") : null };
}

/**
 * "Revise quote" (contract service, w2-backend). Port of
 * QuotationsController#revise + Quotation#revise!: a new draft with the same
 * lines and cover, for staff to change and send again. A quote still awaiting
 * payment is cancelled (so only the revision can be paid) and the old quote's
 * draft order is deleted, so its invoice stops working. The ticket goes back
 * to assessing unless it's cancelled.
 */
import prisma from "../../db.server";
import { reviseQuotation } from "../../models/quotation.server";
import { createTicketActivity } from "../../models/ticket-activity.server";
import { deleteQuoteDraftOrder } from "../repairs/quote-draft-order.server";
import { notifyRepairStatusChanged } from "../repairs/ticket-status.server";
import { authorFor, clientFor, findShopQuotation, type Result } from "./common.server";
import { setTicketStatus, type QuoteActionInput } from "./send.server";

export async function reviseQuote({
  shopId,
  quotationId,
  actor,
  db = prisma,
  ...options
}: QuoteActionInput): Promise<Result<{ newQuotationId: number }>> {
  const found = await findShopQuotation(db, shopId, quotationId);
  if (!found) return { ok: false, error: "Quote not found." };
  const shop = found.repairTicket.shop;
  const previous = found.status.replace(/_/g, " ");

  const revision = await reviseQuotation(quotationId, db);
  if (!revision) return { ok: false, error: "This quote can't be revised." };

  const deleted = found.shopifyDraftOrderId
    ? await deleteQuoteDraftOrder(quotationId, await clientFor(shop, options.client), {
        db,
        logger: options.logger,
      })
    : "";
  const ticket = found.repairTicket;
  if (ticket.status !== "cancelled") {
    const moved = await setTicketStatus(db, ticket.id, "assessing");
    if (moved.changed)
      await notifyRepairStatusChanged(shop, moved.ticket, { db, deps: options.notifyDeps });
  }
  await createTicketActivity(
    {
      repairTicketId: ticket.id,
      activityType: "note",
      author: authorFor(actor),
      body: `Quote revised: a new draft replaces the ${previous} quote.${deleted}`,
    },
    db,
  );
  return { ok: true, newQuotationId: revision.id };
}

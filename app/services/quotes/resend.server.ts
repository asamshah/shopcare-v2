/**
 * "Resend invoice" (contract service, w2-backend). Port of
 * Repairs::QuoteSender#resend: Shopify emails the quote's invoice again. An
 * expired quote is reopened for another full validity period (its draft
 * order was deleted when it expired, so a new one is created), and a ticket
 * left at quote_declined goes back to quoted. Row-locked like sendQuote.
 */
import prisma from "../../db.server";
import { decisionToken } from "../../models/quotation.server";
import { notifyRepairStatusChanged } from "../repairs/ticket-status.server";
import { clientFor, findShopQuotation, withLock } from "./common.server";
import {
  emailInvoice,
  quoteExpiry,
  setTicketStatus,
  type AfterCommit,
  type QuoteActionInput,
  type SendQuoteResult,
} from "./send.server";

export async function resendInvoice({
  shopId,
  quotationId,
  actor,
  db = prisma,
  now = new Date(),
  ...options
}: QuoteActionInput): Promise<SendQuoteResult> {
  const found = await findShopQuotation(db, shopId, quotationId);
  if (!found) return { ok: false, error: "Quote not found." };
  const shop = found.repairTicket.shop;
  const client = await clientFor(shop, options.client);
  const after: AfterCommit = [];

  const result = await withLock(db, "quotations", quotationId, async (tx): Promise<SendQuoteResult> => {
    const quotation = await tx.quotation.findUniqueOrThrow({ where: { id: quotationId } });
    const token = decisionToken(quotation);
    if (!(quotation.status === "sent" || quotation.status === "expired") || !token)
      return { ok: false, error: "Only a quote awaiting payment, or expired, can be re-sent." };

    if (quotation.status === "expired") {
      await tx.quotation.update({
        where: { id: quotationId },
        data: {
          status: "sent",
          decisionExpiresAt: quoteExpiry(shop, now),
          decidedAt: null,
          decidedBy: null,
        },
      });
      const ticket = await tx.repairTicket.findUniqueOrThrow({
        where: { id: quotation.repairTicketId },
      });
      if (ticket.status === "quote_declined") {
        const moved = await setTicketStatus(tx, ticket.id, "quoted");
        after.push(() =>
          notifyRepairStatusChanged(shop, moved.ticket, { deps: options.notifyDeps }),
        );
      }
    }
    return emailInvoice(quotationId, token, "Invoice re-sent to the customer", {
      tx,
      shop,
      client,
      now,
      actor,
      after,
      options,
    });
  });

  for (const step of after) await step();
  return result;
}

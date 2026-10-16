/**
 * Daily: sent quotes the customer didn't pay in time expire (treated like a
 * decline with no reason), so the ticket shows quote_declined for staff to
 * revise. Port of ExpireQuotesJob; each quote goes through expireQuote
 * (row-locked, so a quote expired meanwhile by its review page is skipped).
 * One failure doesn't stop the rest; the job throws at the end so it's
 * retried (expiring is idempotent).
 */
import prisma from "../db.server";
import { decisionOverdueWhere } from "../models/quotation.server";
import { expireQuote } from "../services/quotes/decision.server";
import type { ServiceOptions } from "../services/quotes/common.server";

export async function expireOverdueQuotes(
  { db = prisma, now = new Date(), ...options }: ServiceOptions = {},
): Promise<{ expired: number; failed: number[] }> {
  const overdue = await db.quotation.findMany({
    where: { ...decisionOverdueWhere(now), repairTicket: { shop: { uninstalledAt: null } } },
    include: { repairTicket: { select: { shopId: true } } },
    orderBy: { id: "asc" },
  });
  let expired = 0;
  const failed: number[] = [];
  for (const quotation of overdue) {
    try {
      const result = await expireQuote({
        shopId: quotation.repairTicket.shopId,
        quotationId: quotation.id,
        db,
        now,
        ...options,
      });
      if (result.ok) expired++;
    } catch (error) {
      failed.push(quotation.id);
      console.error(`[job:expire-quotes] quotation=${quotation.id}`, error);
    }
  }
  return { expired, failed };
}

export async function expireQuotesJob(): Promise<void> {
  const { expired, failed } = await expireOverdueQuotes();
  console.info(`[job:expire-quotes] expired ${expired} quotes`);
  if (failed.length) throw new Error(`expiring quotations ${failed.join(", ")} failed`);
}

import type { Quotation, Shop } from "@prisma/client";
import prisma from "../db.server";
import { decisionToken, isDecisionOverdue } from "../models/quotation.server";
import { RECENT_ORDER } from "../models/repair-ticket.server";
import { completeWorkshopAddress, proxyPathPrefix } from "../models/shop.server";
import { postageSlipStatusPath } from "../services/repairs/postage-slip.server";
import { storefrontRoute } from "../services/storefront/deps.server";
import {
  compact,
  iso8601,
  isoDate,
  money2,
  REPAIR_STEPS,
  repairStep,
  statusLabel,
} from "../services/storefront/json.server";
import { storefrontCurrency } from "../services/storefront/care-json.server";
import { itemLabel } from "../models/item.server";
import { coverJson } from "../services/storefront/product-cards.server";

/**
 * GET /apps/repairs/status → /proxy/status. The logged-in customer's own
 * repair tickets (newest 50), each with the cover it was raised under and
 * its current quote, linked to the quote's review page while it awaits
 * payment. A ticket awaiting the customer's item links its postage slip
 * (signed for a day). Per customer: never cached. Port of
 * Proxy::StatusController.
 *
 * v2: ShopCare sends no status emails, so each ticket carries its step
 * (`step`, an index into `steps`: Requested → Quoted → Awaiting item →
 * Received → In repair → Returned; absent when cancelled or rejected), and
 * the customer's unexpired Care credit codes are listed (`care_credits`),
 * since ShopCare doesn't email those either.
 */
export const loader = storefrontRoute({}, async (ctx) => {
  const customerId = await ctx.currentCustomerId();
  if (!customerId) {
    return ctx.json({ ok: true, logged_in: false, tickets: [], care_credits: [] }, { cache: "no-store" });
  }
  const shop = ctx.shopRecord;
  const now = ctx.deps.now();
  const slips = completeWorkshopAddress(shop) !== null;
  const tickets = await prisma.repairTicket.findMany({
    where: { shopId: shop.id, shopifyCustomerId: customerId },
    include: {
      cover: true,
      quotations: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 },
    },
    orderBy: RECENT_ORDER,
    take: 50,
  });
  const credits = await prisma.careCredit.findMany({
    where: {
      shopId: shop.id,
      cover: { item: { shopifyCustomerId: customerId } },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    include: { cover: { include: { item: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 20,
  });
  const currency = storefrontCurrency(shop);
  return ctx.json(
    {
      ok: true,
      logged_in: true,
      steps: REPAIR_STEPS,
      care_credits: credits.map((credit) =>
        compact({
          code: credit.code,
          amount: money2(credit.amount),
          currency,
          expires_at: isoDate(credit.expiresAt),
          product_title: itemLabel(credit.cover.item),
        }),
      ),
      tickets: tickets.map((ticket) =>
        compact({
          id: ticket.id,
          status: ticket.status,
          status_label: statusLabel(ticket.status),
          step: repairStep(ticket.status),
          product_title: ticket.productTitle,
          created_at: iso8601(ticket.createdAt),
          cover: ticket.cover ? coverJson(ticket.cover) : null,
          quotation: quotationJson(shop, ticket.quotations[0] ?? null, now),
          postage_slip_url:
            slips && ticket.status === "awaiting_item" ? postageSlipStatusPath(shop, ticket.id, now) : null,
        }),
      ),
    },
    { cache: "no-store" },
  );
});

function quotationJson(shop: Shop, quotation: Quotation | null, now: Date) {
  if (!quotation) return null;
  const sent = quotation.status === "sent";
  const token = decisionToken(quotation);
  return compact({
    status: quotation.status,
    currency: quotation.currency,
    subtotal: money2(quotation.subtotal),
    // The quote's review page (pay or decline), while it awaits payment.
    review_url:
      sent && !isDecisionOverdue(quotation, now) && token
        ? `${proxyPathPrefix(shop)}/quotes/${token}`
        : null,
    expires_at: sent ? iso8601(quotation.decisionExpiresAt) : null,
  });
}

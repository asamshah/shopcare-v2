/**
 * "Needs attention" at the top of the Tickets home: what staff should act on,
 * so ShopCare works fully without Shopify Flow staff emails (Flow stays an
 * optional extra).
 *
 *   new_requests    new / assessing tickets with no quote sent yet
 *   declined        the latest quote was declined (with the customer's reason)
 *   expired         the latest quote expired unpaid
 *   awaiting_item   paid (or £0 covered) more than N days ago and the item
 *                   hasn't arrived (Settings → Repairs, default 14 days)
 *   received        the item is here but the repair hasn't started
 *
 * Paid repair orders also reach staff through Shopify's own staff order
 * notifications (Settings → Notifications → Staff notifications).
 */
import type { Prisma, Shop } from "@prisma/client";
import prisma from "../../db.server";
import { addDays } from "../../lib/dates";
import { formatDate } from "../../lib/format";
import { awaitingItemDays } from "../../models/shop.server";

/** Rows shown per group (the header shows the full count). */
export const ATTENTION_LIMIT = 10;

export const ATTENTION_GROUPS = ["new_requests", "declined", "expired", "awaiting_item", "received"] as const;
export type AttentionGroup = (typeof ATTENTION_GROUPS)[number];

export const ATTENTION_LABELS: Record<AttentionGroup, string> = {
  new_requests: "New repair requests to quote",
  declined: "Quotes declined",
  expired: "Quotes expired",
  awaiting_item: "Paid, item not received",
  received: "Received, not started",
};

export interface AttentionRow {
  ticketId: number;
  customer: string;
  product: string;
  /** e.g. "Reason: too expensive", "Paid 3 October 2026". */
  detail: string;
}

export interface NeedsAttention {
  total: number;
  awaitingItemDays: number;
  groups: { group: AttentionGroup; label: string; count: number; rows: AttentionRow[] }[];
}

const LATEST_QUOTE = { orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }], take: 1 };

type TicketWithQuote = Prisma.RepairTicketGetPayload<{ include: { quotations: typeof LATEST_QUOTE } }>;

function row(ticket: TicketWithQuote, detail: string): AttentionRow {
  return {
    ticketId: ticket.id,
    customer: ticket.customerName?.trim() || ticket.customerEmail || "",
    product: ticket.productTitle ?? "",
    detail,
  };
}

export async function needsAttention(
  shop: Pick<Shop, "id" | "settings">,
  { now = new Date(), db = prisma }: { now?: Date; db?: typeof prisma } = {},
): Promise<NeedsAttention> {
  const days = awaitingItemDays(shop);
  const tickets = await db.repairTicket.findMany({
    where: { shopId: shop.id, status: { in: ["new", "assessing", "quote_declined", "awaiting_item", "received"] } },
    include: { quotations: LATEST_QUOTE },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
  });

  const groups: Record<AttentionGroup, AttentionRow[]> = {
    new_requests: [],
    declined: [],
    expired: [],
    awaiting_item: [],
    received: [],
  };
  const cutoff = addDays(now, -days);
  for (const ticket of tickets) {
    const quote = ticket.quotations[0];
    switch (ticket.status) {
      case "new":
      case "assessing":
        if (!quote || quote.status === "draft")
          groups.new_requests.push(row(ticket, `Requested ${formatDate(ticket.createdAt)}`));
        break;
      case "quote_declined":
        if (quote?.status === "expired")
          groups.expired.push(
            row(ticket, `Expired ${formatDate(quote.decidedAt ?? quote.decisionExpiresAt ?? ticket.updatedAt)}`),
          );
        else
          groups.declined.push(
            row(ticket, quote?.decisionReason?.trim() ? `Reason: ${quote.decisionReason.trim()}` : "No reason given"),
          );
        break;
      case "awaiting_item": {
        const since = quote?.paidAt ?? ticket.updatedAt;
        if (since <= cutoff) groups.awaiting_item.push(row(ticket, `Paid ${formatDate(since)}`));
        break;
      }
      case "received":
        groups.received.push(
          row(ticket, ticket.itemReceivedAt ? `Received ${formatDate(ticket.itemReceivedAt)}` : "Received"),
        );
        break;
    }
  }

  const list = ATTENTION_GROUPS.map((group) => ({
    group,
    label: ATTENTION_LABELS[group],
    count: groups[group].length,
    rows: groups[group].slice(0, ATTENTION_LIMIT),
  })).filter((g) => g.count > 0);
  return { total: list.reduce((sum, g) => sum + g.count, 0), awaitingItemDays: days, groups: list };
}

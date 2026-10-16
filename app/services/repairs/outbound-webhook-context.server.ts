/**
 * Loads what the outbound-webhook job sends (Rails OutboundWebhookJob#perform):
 * the shop's webhook URL (settings.webhook_url) and decrypted secret, the
 * ticket, and its current (latest) quotation. `shopId` is the Shop row id
 * (as Rails enqueued it) or the shop's myshopify domain. Null when the shop or
 * ticket is gone.
 */
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import { settingsOf, shopSecret } from "../../models/shop.server";
import type { OutboundWebhookContext } from "../../jobs/outbound-webhook.server";

export async function loadOutboundWebhookContext(
  shopId: string,
  ticketId: string,
  db: Db = prisma,
): Promise<OutboundWebhookContext | null> {
  const shop = await db.shop.findUnique({
    where: /^\d+$/.test(shopId) ? { id: Number(shopId) } : { shopifyDomain: shopId },
  });
  if (!shop || !/^\d+$/.test(ticketId)) return null;
  const ticket = await db.repairTicket.findFirst({
    where: { id: Number(ticketId), shopId: shop.id },
  });
  if (!ticket) return null;
  const quotation = await db.quotation.findFirst({
    where: { repairTicketId: ticket.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const url = settingsOf(shop).webhook_url;
  return {
    url: typeof url === "string" ? url : null,
    secret: shopSecret(shop, "webhookSecret"),
    shopDomain: shop.shopifyDomain,
    ticket,
    quotation: quotation
      ? {
          status: quotation.status,
          currency: quotation.currency ?? "",
          subtotal: quotation.subtotal.toString(),
          decisionExpiresAt: quotation.decisionExpiresAt,
          decidedAt: quotation.decidedAt,
          decidedBy: quotation.decidedBy,
          decisionReason: quotation.decisionReason,
          shopifyOrderId: quotation.shopifyOrderId,
        }
      : null,
  };
}

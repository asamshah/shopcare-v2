/**
 * A paid repair quote, from the `orders/paid` webhook. Port of
 * Repairs::PaymentProcessor.
 *
 * Paying a quote's invoice is accepting it: the quote goes from sent to paid
 * in one step (counting the cover's claim), the ticket moves to
 * awaiting_item (the customer is emailed a postage slip) or, when the workshop
 * already has the item, straight to in_repair; the payment is logged, staff are alerted (quote_paid), the customer's
 * storefront status metafield is synced and the `payment` outbound webhook
 * sent. A payment for a cancelled ticket doesn't reopen it: it's flagged for
 * staff instead.
 *
 * Idempotent: the quote is claimed under its row lock, so a retried or
 * concurrent delivery finds it already paid and does nothing.
 */
import type { Shop } from "@prisma/client";
import prisma from "../../db.server";
import { recordClaim } from "../../models/cover.server";
import { coverApplied } from "../../models/quotation.server";
import { statusAfterPayment } from "../../models/repair-ticket.server";
import { repairOrderTag } from "../../models/shop.server";
import { createTicketActivity } from "../../models/ticket-activity.server";
import { updateRepairStatus } from "../../shopify/customers.server";
import { errorSummary } from "../../shopify/graphql.server";
import { notifyQuotePaid } from "../quotes/notifications.server";
import {
  clientFor,
  emitTicketWebhook,
  withLock,
  type ServiceOptions,
} from "../quotes/common.server";
import { setTicketStatus } from "../quotes/send.server";
import { notifyRepairStatusChanged } from "../repairs/ticket-status.server";

/** Quote statuses a payment can be applied to (see claim). */
export const PAYABLE = ["sent", "declined", "expired", "cancelled"];

export type PaymentOutcome =
  | "not_repair"
  | "no_quotation"
  | "already_paid"
  | "not_sent"
  | "ok";

/** The parts of the orders/paid body this reads (REST shape, string keys). */
export interface PaidOrderBody {
  id: number | string;
  admin_graphql_api_id?: string | null;
  name?: string;
  tags?: string | null;
  note_attributes?: { name: string; value: unknown }[] | null;
  draft_order_id?: number | string | null;
  total_price?: string | number | null;
  currency?: string | null;
}

const orderIdOf = (order: PaidOrderBody) =>
  order.admin_graphql_api_id?.match(/\d+$/)?.[0] ?? String(order.id);

export function isRepairOrder(shop: Pick<Shop, "settings">, order: PaidOrderBody): boolean {
  const tags = (order.tags ?? "").split(",").map((t) => t.trim().toLowerCase());
  return tags.includes(repairOrderTag(shop).toLowerCase());
}

export async function processRepairPayment(
  shop: Shop,
  order: PaidOrderBody,
  { db = prisma, now = new Date(), ...options }: ServiceOptions = {},
): Promise<PaymentOutcome> {
  if (!isRepairOrder(shop, order)) return "not_repair";

  // Primary link: the repair_quotation_id written into the draft order's
  // custom attributes when the quote was sent; else the source draft order.
  const qid = order.note_attributes?.find((a) => a.name === "repair_quotation_id")?.value;
  const draftId = order.draft_order_id == null ? "" : String(order.draft_order_id);
  const quotation = qid != null && /^\d+$/.test(String(qid))
    ? await db.quotation.findFirst({
        where: { id: Number(qid), repairTicket: { shopId: shop.id } },
      })
    : draftId
      ? await db.quotation.findFirst({
          where: { shopifyDraftOrderId: draftId, repairTicket: { shopId: shop.id } },
        })
      : null;
  if (!quotation) return "no_quotation";

  const logger = options.logger ?? console;
  const claim = await withLock(db, "quotations", quotation.id, async (tx) => {
    const fresh = await tx.quotation.findUniqueOrThrow({
      where: { id: quotation.id },
      include: { cover: true },
    });
    if (fresh.status === "paid") return { outcome: "already_paid" as const };
    if (!PAYABLE.includes(fresh.status)) {
      logger.error(
        `[payments/repair-payment] quotation=${fresh.id} is ${fresh.status}: order ${order.id} not applied`,
      );
      return { outcome: "not_sent" as const };
    }
    const paid = await tx.quotation.update({
      where: { id: fresh.id },
      data: {
        status: "paid",
        paidAt: now,
        shopifyOrderId: orderIdOf(order),
        decidedAt: now,
        decidedBy: "customer",
        decisionReason: null,
      },
    });
    if (coverApplied(fresh) && fresh.cover) await recordClaim(fresh.cover.id, tx);
    const ticket = await tx.repairTicket.findUniqueOrThrow({
      where: { id: fresh.repairTicketId },
    });
    const received =
      `The customer paid the invoice, accepting the quote (order ${order.name ?? ""}, ` +
      `${order.total_price ?? ""} ${order.currency ?? ""}).`;
    if (ticket.status === "cancelled") {
      await createTicketActivity(
        {
          repairTicketId: ticket.id,
          activityType: "payment",
          author: "system",
          body: `${received} This ticket is cancelled: check the order and refund or reopen the repair.`,
        },
        tx,
      );
      return { outcome: "ok" as const, paid, moved: { ticket, changed: false } };
    }
    const next = statusAfterPayment(ticket);
    const moved = await setTicketStatus(tx, ticket.id, next);
    await createTicketActivity(
      {
        repairTicketId: ticket.id,
        activityType: "payment",
        author: "system",
        body: `${received} ${next === "in_repair" ? "Repair started." : "Waiting for the customer to send the item."}`,
      },
      tx,
    );
    return { outcome: "ok" as const, paid, moved };
  });
  if (claim.outcome !== "ok") return claim.outcome;

  const { paid, moved } = claim;
  const ticket = moved.ticket;
  const notifyOptions = { db, deps: options.notifyDeps };
  if (ticket.status !== "cancelled")
    await notifyQuotePaid(shop, paid, ticket, order.name ?? "", notifyOptions);
  if (moved.changed) await notifyRepairStatusChanged(shop, ticket, notifyOptions);

  // The storefront's repair status for this product (Rails sync_customer_metafield).
  if (ticket.shopifyCustomerId && ticket.productId) {
    try {
      const key = [ticket.productId, ticket.variantId].filter((v) => v?.trim()).join("_");
      await updateRepairStatus(
        await clientFor(shop, options.client),
        ticket.shopifyCustomerId,
        key,
        "paid",
      );
    } catch (error) {
      logger.error(
        `[payments/repair-payment] metafield sync failed for shop=${shop.shopifyDomain}: ${errorSummary(error)}`,
      );
    }
  }
  await emitTicketWebhook(shop, ticket.id, "payment", null, options);
  return "ok";
}

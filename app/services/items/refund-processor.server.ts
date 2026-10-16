/**
 * `refunds/create`: a refunded unit is no longer the customer's, so its Item
 * is marked refunded and its cover cancelled, highest units first. A refunded
 * Care plan line (not an Item) cancels the Care cover bought on it. Each Care
 * plan cancelled is then refunded, credited or left to staff
 * (handleCareRefund). Port of Items::RefundProcessor.
 *
 * A refund is applied once: its id is recorded (processed_refunds) in the
 * same transaction as the Items and covers it changes, so a retried or late
 * duplicate delivery does nothing, while a delivery that fails part-way rolls
 * back and can be retried. Each Item and cover is also locked and skipped
 * unless still active. The Care plans are handled after commit, as that can
 * call Shopify.
 */
import type { Shop } from "@prisma/client";
import prisma from "../../db.server";
import { withRowLock } from "../../lib/db-lock.server";
import { numericId } from "../../lib/gid";
import { handleCareRefund, type RefundHandlerOptions } from "../care/refund-handler.server";

/** The parts of the refunds/create body this reads. */
export interface RefundWebhookBody {
  id?: number | string | null;
  admin_graphql_api_id?: string | null;
  order_id?: number | string | null;
  refund_line_items?: {
    line_item_id?: number | string | null;
    quantity?: number | string | null;
    line_item?: { admin_graphql_api_id?: string | null } | null;
  }[] | null;
}

export type CareHandler = (coverId: number, alreadyRefundedLineIds: string[]) => Promise<unknown>;

export interface RefundProcessorOptions {
  db?: typeof prisma;
  /** Deals with each cancelled Care cover; defaults to handleCareRefund. */
  careHandler?: CareHandler;
  careOptions?: RefundHandlerOptions;
}

function refundLines(refund: RefundWebhookBody): [string, number][] {
  return (refund.refund_line_items ?? []).flatMap((line) => {
    const gid = line.line_item?.admin_graphql_api_id;
    const id = gid ? numericId(gid) : line.line_item_id == null ? "" : String(line.line_item_id);
    const quantity = Math.trunc(Number(line.quantity) || 0);
    return id && quantity > 0 ? [[id, quantity] as [string, number]] : [];
  });
}

/** Returns the number of Items marked refunded (0 for a refund already applied). */
export async function processRefund(
  shop: Pick<Shop, "id" | "shopifyDomain" | "settings">,
  refund: RefundWebhookBody,
  { db = prisma, careHandler, careOptions }: RefundProcessorOptions = {},
): Promise<number> {
  const lines = refundLines(refund);
  const refundId = refund.admin_graphql_api_id
    ? numericId(refund.admin_graphql_api_id)
    : refund.id == null ? "" : String(refund.id);

  const { count, cancelledCare } = await db.$transaction(
    async (tx) => {
      const cancelledCare: { id: number; lineItemId: string | null }[] = [];
      if (refundId) {
        const claimed = await tx.$queryRaw<{ id: number }[]>`
          INSERT INTO processed_refunds (shop_id, refund_id, order_id, created_at, updated_at)
          VALUES (${shop.id}, ${refundId}, ${refund.order_id == null ? null : String(refund.order_id)}, now(), now())
          ON CONFLICT (shop_id, refund_id) DO NOTHING
          RETURNING id`;
        if (claimed.length === 0) return { count: 0, cancelledCare };
      }

      let count = 0;
      for (const [lineItemId, quantity] of lines) {
        const items = await tx.item.findMany({
          where: { shopId: shop.id, status: "active", orderLineId: lineItemId },
          orderBy: { unitIndex: "desc" },
          take: quantity,
        });
        for (const candidate of items) {
          await withRowLock(tx, "items", candidate.id);
          const item = await tx.item.findUniqueOrThrow({ where: { id: candidate.id } });
          if (item.status !== "active") continue;
          await tx.item.update({ where: { id: item.id }, data: { status: "refunded" } });
          const covers = await tx.cover.findMany({ where: { itemId: item.id, status: "active" } });
          for (const cover of covers) {
            await tx.cover.update({ where: { id: cover.id }, data: { status: "cancelled" } });
            if (cover.kind === "care")
              cancelledCare.push({ id: cover.id, lineItemId: cover.shopifyLineItemId });
          }
          count++;
        }
      }

      // A refunded Care line: cancel up to `quantity` of the covers bought on
      // it, less any this refund already cancelled with their items.
      for (const [lineItemId, quantity] of lines) {
        const remaining =
          quantity - cancelledCare.filter((c) => c.lineItemId === lineItemId).length;
        if (remaining <= 0) continue;
        const covers = await tx.cover.findMany({
          where: { shopId: shop.id, kind: "care", status: "active", shopifyLineItemId: lineItemId },
          orderBy: [{ item: { unitIndex: "desc" } }, { id: "desc" }],
          take: remaining,
        });
        for (const candidate of covers) {
          await withRowLock(tx, "covers", candidate.id);
          const cover = await tx.cover.findUniqueOrThrow({ where: { id: candidate.id } });
          if (cover.status !== "active") continue;
          await tx.cover.update({ where: { id: cover.id }, data: { status: "cancelled" } });
          cancelledCare.push({ id: cover.id, lineItemId: cover.shopifyLineItemId });
        }
      }
      return { count, cancelledCare };
    },
    { maxWait: 15_000, timeout: 60_000 },
  );

  const refundedLineIds = lines.map(([id]) => id);
  const handle: CareHandler =
    careHandler ??
    ((coverId, already) => {
      if (!careOptions) throw new Error("processRefund needs careOptions or a careHandler");
      return handleCareRefund(shop, coverId, already, { db, ...careOptions });
    });
  for (const cover of cancelledCare) await handle(cover.id, refundedLineIds);
  return count;
}

/**
 * A trade-in added on the product page rides on the purchased line as the
 * hidden property `_shopcare_trade_in`. When that order is paid, the trade-in
 * becomes a real request and the customer is told what happens next. Port of
 * TradeIns::OrderLinker (run from orders/paid when trade-in is enabled).
 *
 * Idempotent: only `pending_purchase` trade-ins are linked, each under its
 * row lock, so a retried webhook links nothing twice.
 */
import type { Shop, TradeIn } from "@prisma/client";
import prisma from "../../db.server";
import { inTransaction, withRowLock, type Db } from "../../lib/db-lock.server";
import { inProgressWhere } from "../../models/trade-in.server";
import type { OrderData } from "../../shopify/orders.server";
import type { NotifyOptions } from "../notifications/notify.server";
import { notifyTradeInStatus } from "./notify-status.server";

export const TRADE_IN_PROPERTY = "_shopcare_trade_in";

const present = (value: string | null | undefined) => (value?.trim() ? value : null);

/** Returns the trade-ins it linked. */
export async function linkTradeInsToOrder(
  shop: Pick<Shop, "id" | "shopifyDomain">,
  order: OrderData,
  { db = prisma, notifyOptions }: { db?: Db; notifyOptions?: NotifyOptions } = {},
): Promise<TradeIn[]> {
  const ids = [
    ...new Set(
      order.lines
        .map((line) => String(line.properties?.[TRADE_IN_PROPERTY] ?? "").trim())
        .filter((id) => /^\d+$/.test(id))
        .map(Number),
    ),
  ];
  if (ids.length === 0) return [];

  const candidates = await db.tradeIn.findMany({
    where: { shopId: shop.id, id: { in: ids }, status: "pending_purchase" },
    orderBy: { id: "asc" },
  });
  const linked: TradeIn[] = [];
  for (const candidate of candidates) {
    const updated = await inTransaction(db, async (tx) => {
      await withRowLock(tx, "trade_ins", candidate.id);
      const tradeIn = await tx.tradeIn.findUniqueOrThrow({ where: { id: candidate.id } });
      if (tradeIn.status !== "pending_purchase") return null;
      // The customer on the order must be the one who started it.
      if (tradeIn.shopifyCustomerId && tradeIn.shopifyCustomerId !== order.customerId) return null;
      // Only one trade-in per item can be in progress.
      if (
        tradeIn.itemId &&
        (await tx.tradeIn.count({
          where: { shopId: shop.id, itemId: tradeIn.itemId, ...inProgressWhere },
        })) > 0
      )
        return null;
      return tx.tradeIn.update({
        where: { id: tradeIn.id },
        data: {
          status: "requested",
          shopifyOrderId: order.id,
          orderName: order.name,
          shopifyCustomerId: tradeIn.shopifyCustomerId ?? order.customerId,
          customerEmail: present(tradeIn.customerEmail) ?? order.email,
          customerName: present(tradeIn.customerName) ?? order.customerName,
        },
      });
    });
    if (!updated) continue;
    await notifyTradeInStatus(shop, updated, { db, ...notifyOptions });
    linked.push(updated);
  }
  return linked;
}

/**
 * Tells the customer their trade-in moved along (`trade_in_status_changed`;
 * Flow / Klaviyo only for now, no ShopCare email). Port of
 * TradeIns::Workflow#notify_status, shared by the order linker and the
 * workflow.
 */
import type { Shop, TradeIn, TradeInProgram } from "@prisma/client";
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import { tradeInCredit } from "../../models/trade-in.server";
import { notify, type NotifyOptions } from "../notifications/notify.server";

export async function notifyTradeInStatus(
  shop: Pick<Shop, "shopifyDomain">,
  tradeIn: TradeIn & { tradeInProgram?: TradeInProgram | null },
  { db = prisma, ...options }: NotifyOptions & { db?: Db } = {},
): Promise<void> {
  const program =
    tradeIn.tradeInProgram ??
    (tradeIn.tradeInProgramId
      ? await db.tradeInProgram.findUnique({ where: { id: tradeIn.tradeInProgramId } })
      : null);
  await notify(
    shop.shopifyDomain,
    "trade_in_status_changed",
    {
      customerId: tradeIn.shopifyCustomerId,
      email: tradeIn.customerEmail,
      name: tradeIn.customerName,
    },
    {
      tradeInId: tradeIn.id,
      status: tradeIn.status,
      productTitle: tradeIn.productTitle,
      credit: Number(tradeInCredit(tradeIn)),
      instructions: tradeIn.status === "approved" ? (program?.instructions ?? "") : "",
      creditCode:
        tradeIn.creditMethod === "discount_code" ? (tradeIn.creditReference ?? "") : "",
    },
    { db, ...options },
  );
}

/**
 * When an item with Care is refunded, its Care plan is dealt with as the
 * merchant chose in Settings → Care plans (`refund_action`):
 *   refund  refund the Care line on the original order (refundCarePlan)
 *   credit  a single-use discount code worth what the customer paid
 *           (issueCareCredit), and tell the customer (care_credit_offer)
 *   manual  just cancel the cover; staff decide
 * A Care line refunded in the same Shopify refund needs nothing more
 * ("refunded_by_merchant"). The outcome is recorded on the cover
 * (`usage.refund`) and shown in admin. Never throws: a failure is recorded
 * as status "failed" with the error. Port of Care::RefundHandler.
 */
import type { Cover, Item, Prisma, Shop } from "@prisma/client";
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import { coverName } from "../../models/cover.server";
import { itemLabel } from "../../models/item.server";
import { careSettings } from "../../models/shop.server";
import { jsonObject } from "../../models/validation.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";
import { notify, type NotifyOptions } from "../notifications/notify.server";
import { issueCareCredit } from "./credit-issuer.server";
import { refundCarePlan } from "./plan-refunder.server";

export interface RefundHandlerOptions {
  db?: Db;
  now?: Date;
  /** Resolved lazily: only the refund/credit actions call Shopify. */
  client: () => Promise<AdminGraphqlClient>;
  currency: () => Promise<string>;
  notifyOptions?: NotifyOptions;
  logger?: Pick<Console, "error">;
}

export type RefundRecord = Record<string, string>;

export async function handleCareRefund(
  shop: Pick<Shop, "id" | "shopifyDomain" | "settings">,
  coverId: number,
  alreadyRefundedLineIds: string[],
  { db = prisma, now = new Date(), client, currency, notifyOptions, logger = console }: RefundHandlerOptions,
): Promise<RefundRecord> {
  const cover = await db.cover.findUniqueOrThrow({
    where: { id: coverId },
    include: { item: true },
  });
  const action = String(careSettings(shop).refund_action ?? "refund");
  const record = async (act: string, status: string, extra: Record<string, string> = {}) => {
    const entry = { action: act, status, at: now.toISOString().replace(/\.\d{3}Z$/, "Z"), ...extra };
    await db.cover.update({
      where: { id: cover.id },
      data: { usage: { ...jsonObject(cover.usage), refund: entry } as Prisma.InputJsonValue },
    });
    return entry;
  };

  if (alreadyRefundedLineIds.map(String).includes(String(cover.shopifyLineItemId ?? "")))
    return record("refunded_by_merchant", "done");

  try {
    if (action === "refund") {
      const refundId = await refundCarePlan(await client(), cover);
      return await record("refund", "done", { refund_id: refundId });
    }
    if (action === "credit") return await credit(shop, cover, record, { db, now, client, currency, notifyOptions });
    return await record("manual", "needs_action");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[care/refund-handler] cover ${cover.id}: ${message}`);
    return record(action, "failed", { error: message });
  }
}

async function credit(
  shop: Pick<Shop, "id" | "shopifyDomain" | "settings">,
  cover: Cover & { item: Item },
  record: (act: string, status: string, extra?: Record<string, string>) => Promise<RefundRecord>,
  { db, now, client, currency, notifyOptions }: Required<Pick<RefundHandlerOptions, "db" | "now">> &
    Pick<RefundHandlerOptions, "client" | "currency" | "notifyOptions">,
): Promise<RefundRecord> {
  const issued = await issueCareCredit(shop, await client(), cover, { db, now });
  await notify(
    shop.shopifyDomain,
    "care_credit_offer",
    {
      customerId: cover.item.shopifyCustomerId,
      email: cover.item.customerEmail,
      name: cover.item.customerName,
    },
    {
      coverId: cover.id,
      carePlan: coverName(cover),
      productTitle: itemLabel(cover.item),
      creditCode: issued.code,
      creditAmount: Number(issued.amount),
      currency: await currency(),
      creditExpires: issued.expiresAt ? issued.expiresAt.toISOString().slice(0, 10) : "",
      customerName: cover.item.customerName,
    },
    { db, ...notifyOptions },
  );
  return record("credit", "done", { code: issued.code });
}

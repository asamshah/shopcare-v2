/**
 * The events around a Care purchase (Flow / Klaviyo, when connected; the
 * customer's confirmation is the Care section of Shopify's order
 * confirmation). Port of Care::Notices:
 *   care_activated  each Care plan bought (emitted here, from the
 *                   orders/paid webhook)
 *   care_offer      v2: no longer sent straight after the order; the daily
 *                   care-offers job emits it `care_offer_delay_days` after
 *                   purchase (app/services/care/care-offers.server.ts)
 */
import type { Cover, Shop } from "@prisma/client";
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import { coverName } from "../../models/cover.server";
import { itemLabel } from "../../models/item.server";
import { notify, type NotifyOptions } from "../notifications/notify.server";

export async function notifyCareActivated(
  shop: Pick<Shop, "shopifyDomain">,
  covers: Pick<Cover, "id" | "itemId" | "kind" | "terms" | "endsAt">[],
  { db = prisma, ...options }: NotifyOptions & { db?: Db } = {},
): Promise<void> {
  for (const cover of covers) {
    const item = await db.item.findUnique({ where: { id: cover.itemId } });
    if (!item) continue;
    await notify(
      shop.shopifyDomain,
      "care_activated",
      { customerId: item.shopifyCustomerId, email: item.customerEmail, name: item.customerName },
      {
        coverId: cover.id,
        carePlan: coverName(cover),
        productTitle: itemLabel(item),
        coverEnds: cover.endsAt.toISOString().slice(0, 10),
        customerName: item.customerName,
      },
      { db, ...options },
    );
  }
}

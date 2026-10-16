/**
 * "Add Care to your purchase" (the `care_offer` notification), v2 timing.
 *
 * Rails emitted it straight after the order (Care::Notices#offer) and left
 * the delay to the merchant's Flow/Klaviyo. In v2 the delay is ours: a daily
 * job (netlify/functions/daily-care-offers.mts → "care-offers" job) emits it
 * `care_offer_delay_days` (default 7) after purchase. ShopCare never emails
 * it: it's marketing, so it goes out only if the merchant wires the Flow
 * trigger to Shopify Email's "Send marketing email" (which only sends to
 * customers subscribed to email marketing) or builds a Klaviyo flow on it.
 *
 * One offer per order, as in Rails: the first item that can still have Care
 * added names the plan; every offered item's title is listed. Orders whose
 * offer day was missed by up to CATCH_UP_DAYS (a failed run) are still sent;
 * the notification idempotency key (`care_offer:order_<id>`) stops repeats.
 */
import type { Shop } from "@prisma/client";
import prisma from "../../db.server";
import { addDays } from "../../lib/dates";
import type { Db } from "../../lib/db-lock.server";
import { toSentence } from "../../lib/inflections";
import { activeCarePlans } from "../../models/care-plan.server";
import {
  COVERS_ORDER,
  carePlansOnOffer,
  itemLabel,
} from "../../models/item.server";
import { careOfferDelayDays, careSettings } from "../../models/shop.server";
import type { EventData } from "../notifications/events.server";
import type { DeliveryRecipient } from "../notifications/store.server";

export const CATCH_UP_DAYS = 2;

export interface DueCareOffer {
  recipient: DeliveryRecipient;
  data: EventData["care_offer"];
}

/** The window of purchase times whose offer is due at `now`. */
export function careOfferWindow(
  shop: Pick<Shop, "settings">,
  now: Date,
): { from: Date; to: Date } {
  const to = addDays(now, -careOfferDelayDays(shop));
  return { from: addDays(to, -CATCH_UP_DAYS), to };
}

/**
 * The care_offer events due for a shop at `now`. `currency` is the shop's
 * currency (ISO 4217), asked for only when there is something to offer.
 */
export async function dueCareOffers(
  shop: Pick<Shop, "id" | "settings">,
  {
    now = new Date(),
    currency,
    db = prisma,
  }: { now?: Date; currency: () => Promise<string>; db?: Db },
): Promise<DueCareOffer[]> {
  const { from, to } = careOfferWindow(shop, now);
  const items = await db.item.findMany({
    where: {
      shopId: shop.id,
      source: "order",
      status: "active",
      orderId: { not: null },
      purchasedAt: { gt: from, lte: to },
    },
    include: { covers: { orderBy: COVERS_ORDER } },
    orderBy: [{ purchasedAt: "asc" }, { id: "asc" }],
  });
  if (items.length === 0) return [];
  const plans = await activeCarePlans(shop.id, db);
  if (plans.length === 0) return [];

  const byOrder = new Map<string, typeof items>();
  for (const item of items) {
    const list = byOrder.get(item.orderId!) ?? [];
    list.push(item);
    byOrder.set(item.orderId!, list);
  }

  const addCareUrl = String(careSettings(shop).add_later_url ?? "");
  let shopCurrency: string | undefined;
  const offers: DueCareOffer[] = [];
  for (const [orderId, orderItems] of byOrder) {
    const offered = orderItems
      .map((item) => ({ item, plans: carePlansOnOffer(item, plans, now) }))
      .filter((offer) => offer.plans.length > 0);
    if (offered.length === 0) continue;

    const { item, plans: onOffer } = offered[0];
    const deadline = new Date(
      Math.max(
        ...onOffer.map((plan) =>
          addDays(item.purchasedAt!, plan.offerWindowDays).getTime(),
        ),
      ),
    );
    shopCurrency ??= await currency();
    offers.push({
      recipient: {
        customerId: item.shopifyCustomerId,
        email: item.customerEmail,
        name: item.customerName,
      },
      data: {
        orderId,
        productTitle: toSentence([
          ...new Set(offered.map((offer) => itemLabel(offer.item))),
        ]),
        carePlan: onOffer[0].name,
        carePrice: Number(onOffer[0].price),
        currency: shopCurrency,
        offerEnds: deadline.toISOString().slice(0, 10),
        addCareUrl,
        customerName: item.customerName,
      },
    });
  }
  return offers;
}

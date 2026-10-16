/**
 * The "Add Care" offer without Flow: customers who can still add Care to a
 * recent purchase carry the Shopify customer tag CARE_OFFER_TAG, so the
 * merchant can target them with a Shopify Email campaign or a customer
 * segment (`customer_tags CONTAINS 'shopcare-care-offer-eligible'`). Shopify
 * Email only sends marketing to subscribed customers, so consent stays
 * Shopify's.
 *
 * Eligible = a logged-in customer (guests have no Shopify customer to tag)
 * with an active order Item bought at least `care_offer_delay_days` ago that
 * still has a Care plan on offer (no Care yet, within the plan's offer
 * window): the same rule as the care_offer Flow trigger.
 *
 * syncCareOfferTags runs daily with the care-offers job, for every installed
 * shop with a Care plan: it reads who carries the tag in Shopify and adds or
 * removes it so exactly the eligible customers have it (the window ending or
 * Care being bought drops a customer). Buying Care also removes it at once
 * (removeCareOfferTag, from the orders/paid webhook).
 *
 * Needs write_customers (tagsAdd / tagsRemove on a Customer), which ShopCare
 * already has.
 */
import type { Shop } from "@prisma/client";
import prisma from "../../db.server";
import { addDays } from "../../lib/dates";
import type { Db } from "../../lib/db-lock.server";
import { numericId } from "../../lib/gid";
import { activeCarePlans } from "../../models/care-plan.server";
import { COVERS_ORDER, carePlansOnOffer } from "../../models/item.server";
import { careOfferDelayDays } from "../../models/shop.server";
import {
  addCustomerTag,
  customerIdsWithTag,
  removeCustomerTag,
} from "../../shopify/customers.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";

export const CARE_OFFER_TAG = "shopcare-care-offer-eligible";

/** Numeric Shopify ids of the customers eligible for the "Add Care" offer at `now`. */
export async function careOfferEligibleCustomers(
  shop: Pick<Shop, "id" | "settings">,
  { now = new Date(), db = prisma }: { now?: Date; db?: Db } = {},
): Promise<Set<string>> {
  const plans = await activeCarePlans(shop.id, db);
  const longest = Math.max(0, ...plans.map((plan) => plan.offerWindowDays));
  if (plans.length === 0 || longest === 0) return new Set();
  const items = await db.item.findMany({
    where: {
      shopId: shop.id,
      source: "order",
      status: "active",
      shopifyCustomerId: { not: null },
      purchasedAt: { gte: addDays(now, -longest), lte: addDays(now, -careOfferDelayDays(shop)) },
    },
    include: { covers: { orderBy: COVERS_ORDER } },
  });
  return new Set(
    items
      .filter((item) => carePlansOnOffer(item, plans, now).length > 0)
      .map((item) => numericId(item.shopifyCustomerId!)),
  );
}

export interface TagSync {
  added: string[];
  removed: string[];
}

/** Makes the tag match the eligible customers. */
export async function syncCareOfferTags(
  shop: Pick<Shop, "id" | "settings">,
  client: AdminGraphqlClient,
  options: { now?: Date; db?: Db } = {},
): Promise<TagSync> {
  const eligible = await careOfferEligibleCustomers(shop, options);
  const tagged = new Set(await customerIdsWithTag(client, CARE_OFFER_TAG));
  const added = [...eligible].filter((id) => !tagged.has(id)).sort();
  const removed = [...tagged].filter((id) => !eligible.has(id)).sort();
  for (const id of added) await addCustomerTag(client, id, CARE_OFFER_TAG);
  for (const id of removed) await removeCustomerTag(client, id, CARE_OFFER_TAG);
  return { added, removed };
}

/** The customer bought Care: drop the offer tag now rather than at the next daily sync. */
export async function removeCareOfferTag(
  client: AdminGraphqlClient,
  customerIds: (string | null | undefined)[],
  logger: Pick<Console, "error"> = console,
): Promise<void> {
  for (const id of new Set(customerIds.filter((c): c is string => Boolean(c?.trim())).map((c) => numericId(c)))) {
    try {
      await removeCustomerTag(client, id, CARE_OFFER_TAG);
    } catch (error) {
      // The daily sync removes it anyway.
      logger.error(`[care/care-offer-tags] untag customer ${id}`, error);
    }
  }
}

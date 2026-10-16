/**
 * Care plans as the storefront blocks read them (Proxy::CareController
 * `plan_json` / `offer_json`): the PDP offer and "Add Care later".
 */
import type { CarePlan, Shop } from "@prisma/client";
import { addDays } from "../../lib/dates";
import {
  badgeLabel,
  carePlanPriority,
  carePlanTerms,
  exclusionList,
  termText,
} from "../../models/care-plan.server";
import { itemLabel, type ItemWithCovers } from "../../models/item.server";
import { settingsOf } from "../../models/shop.server";
import { d } from "../../models/validation.server";
import { iso8601, isoDate, money2 } from "./json.server";

/** `settings.currency`, else "GBP" (Rails `currency`). */
export function storefrontCurrency(shop: Pick<Shop, "settings">): string {
  const currency = settingsOf(shop).currency;
  return typeof currency === "string" && currency.trim() ? currency : "GBP";
}

export function planBenefits(plan: Pick<CarePlan, "termMonths" | "perks" | "excess">): string[] {
  const list = [`All repairs for ${termText(plan.termMonths)}`];
  if (carePlanPriority(plan)) list.push("Priority turnaround");
  if (d(plan.excess).gt(0)) list.push(`${money2(plan.excess)} excess per repair`);
  return list;
}

/** `badge`: "ShopCare – 2 year plan", as the cover will show once bought. */
export function planJson(
  plan: CarePlan,
  { currency, product }: { currency: string; product?: string | null },
) {
  return {
    id: plan.id,
    name: plan.name,
    badge: badgeLabel(plan.termMonths),
    variant_id: plan.shopifyVariantId,
    price: money2(plan.price),
    term_months: plan.termMonths,
    benefits: planBenefits(plan),
    exclusions: exclusionList(plan),
    terms: carePlanTerms(plan, { currency, product }),
  };
}

export function offerJson(item: ItemWithCovers, plans: CarePlan[], currency: string) {
  return {
    item_id: item.id,
    product_title: itemLabel(item),
    order_name: item.orderName,
    purchased_at: iso8601(item.purchasedAt),
    plans: plans.map((plan) => ({
      ...planJson(plan, { currency, product: item.productTitle }),
      offer_ends: isoDate(addDays(item.purchasedAt!, plan.offerWindowDays)),
    })),
  };
}

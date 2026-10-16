import prisma from "../db.server";
import {
  carePlansOnOffer,
  COVERS_ORDER,
  forCustomerWhere,
  RECENT_ORDER,
} from "../models/item.server";
import { storefrontRoute } from "../services/storefront/deps.server";
import { offerJson, storefrontCurrency } from "../services/storefront/care-json.server";

/**
 * GET /apps/repairs/care_offers → /proxy/care_offers. The logged-in
 * customer's items that can still have Care added ("Add Care later"). Per
 * customer: never cached. Port of Proxy::CareController#offers.
 */
export const loader = storefrontRoute({}, async (ctx) => {
  const customerId = await ctx.currentCustomerId();
  if (!customerId) {
    return ctx.json({ ok: true, logged_in: false, items: [] }, { cache: "no-store" });
  }
  const shop = ctx.shopRecord;
  const now = ctx.deps.now();
  const plans = await prisma.carePlan.findMany({
    where: { shopId: shop.id, active: true },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  const items = await prisma.item.findMany({
    where: { shopId: shop.id, status: "active", ...forCustomerWhere(customerId) },
    include: { covers: { orderBy: COVERS_ORDER } },
    orderBy: RECENT_ORDER,
    take: 50,
  });
  const currency = storefrontCurrency(shop);
  const offers = items.flatMap((item) => {
    const onOffer = carePlansOnOffer(item, plans, now);
    return onOffer.length ? [offerJson(item, onOffer, currency)] : [];
  });
  return ctx.json({ ok: true, logged_in: true, currency, items: offers }, { cache: "no-store" });
});

import prisma from "../db.server";
import { COVERS_ORDER, forCustomerWhere, type ItemWithCovers } from "../models/item.server";
import { fetchPurchaseHistory } from "../shopify/orders.server";
import { storefrontRoute } from "../services/storefront/deps.server";
import { compact } from "../services/storefront/json.server";
import { ProductCards } from "../services/storefront/product-cards.server";

/**
 * GET /apps/repairs/orders → /proxy/orders. The logged-in customer's products,
 * from order history plus any they registered, so the repair form can let
 * them pick one, with the cover each carries and any repair already open for
 * it. Per customer: never cached. Port of Proxy::OrdersController.
 */
export const loader = storefrontRoute({}, async (ctx) => {
  const customerId = await ctx.currentCustomerId();
  if (!customerId) {
    return ctx.json({ ok: true, logged_in: false, products: [] }, { cache: "no-store" });
  }
  const shop = ctx.shopRecord;
  const purchases = await fetchPurchaseHistory(await ctx.deps.adminClient(ctx), customerId);
  const owned: ItemWithCovers[] = await prisma.item.findMany({
    where: { shopId: shop.id, status: "active", ...forCustomerWhere(customerId) },
    include: { covers: { orderBy: COVERS_ORDER } },
    orderBy: { id: "asc" },
  });
  const byLine = new Map<string, ItemWithCovers>();
  for (const item of owned) if (item.orderLineId) byLine.set(item.orderLineId, item);
  const cards = await ProductCards.load(shop, owned, customerId, { now: ctx.deps.now() });

  const products = [
    ...purchases.map((purchase) =>
      cards.card(
        compact({
          product_id: purchase.productId,
          variant_id: purchase.variantId,
          product_title: purchase.productTitle,
          variant_title: purchase.variantTitle,
          image_url: purchase.imageUrl,
          order_name: purchase.orderName,
          order_date: purchase.orderDate,
          order_id: purchase.orderId,
          order_line_id: purchase.orderLineId,
        }),
        byLine.get(purchase.orderLineId) ?? null,
      ),
    ),
    ...owned.filter((item) => item.source === "registration").map((item) => cards.registered(item)),
  ];
  return ctx.json({ ok: true, logged_in: true, products }, { cache: "no-store" });
});

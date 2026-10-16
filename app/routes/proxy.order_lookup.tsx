import { ProductFactsLoader } from "../shopify/product-facts.server";
import { ItemRecorder } from "../services/items/recorder.server";
import { lookUpOrder, orderToken } from "../services/repairs/order-lookup.server";
import { formParams, storefrontRoute, textParam } from "../services/storefront/deps.server";
import { compact, iso8601 } from "../services/storefront/json.server";
import { ProductCards } from "../services/storefront/product-cards.server";

export const NOT_FOUND =
  "We couldn't find that order. Check the order number, and the email address you used at checkout.";

/**
 * POST /apps/repairs/order_lookup → /proxy/order_lookup. Finds one order by
 * number and returns its lines as product cards with their cover. A logged-in
 * customer only finds their own orders; a guest must also give the order's
 * email and gets a signed token (2 hours) the intake re-verifies. Every miss
 * is the same 404, and lookups are rate-limited per visitor and per shop, so
 * it can't be used to probe for orders. Port of Proxy::OrderLookupsController.
 */
export const action = storefrontRoute(
  { throttle: { name: "order_lookup", perIp: 10, perShop: 300, periodSeconds: 600 } },
  async (ctx) => {
    const shop = ctx.shopRecord;
    const form = await formParams(ctx);
    const customerId = await ctx.currentCustomerId();
    const client = await ctx.deps.adminClient(ctx);
    const recorder = new ItemRecorder(shop, {
      facts: new ProductFactsLoader(client, { shopKey: shop.shopifyDomain }),
    });
    const result = await lookUpOrder(shop, client, recorder, textParam(form, "order_number"), {
      customerId,
      email: customerId ? null : textParam(form, "email"),
    });
    if (!result) {
      return ctx.json({ ok: false, error: NOT_FOUND }, { cache: "no-store", status: 404 });
    }

    const { order } = result;
    const cards = await ProductCards.load(shop, result.items, customerId, { now: ctx.deps.now() });
    const products = result.items.map((item) =>
      cards.card(
        compact({
          product_id: item.productId,
          variant_id: item.variantId,
          product_title: item.productTitle,
          variant_title: item.variantTitle,
          image_url: item.orderLineId ? result.images[item.orderLineId] : null,
          order_name: order.name,
          order_date: iso8601(order.processedAt),
          order_id: order.id,
          order_line_id: item.orderLineId,
        }),
        item,
      ),
    );
    return ctx.json(
      compact({
        ok: true,
        order_name: order.name,
        products,
        // Guests: proof for the intake that this order was verified
        // (logged-in customers' lines are re-checked against their own orders).
        order_token: customerId ? null : orderToken(shop, order.id, ctx.deps.now()),
      }),
      { cache: "no-store" },
    );
  },
);

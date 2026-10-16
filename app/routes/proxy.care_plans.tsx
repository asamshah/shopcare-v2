import { activeCarePlans } from "../models/care-plan.server";
import { emptyFacts, type ProductFacts } from "../models/product-facts";
import { appliesTo, needsProductFacts } from "../models/product-grouped.server";
import { ProductFactsLoader } from "../shopify/product-facts.server";
import { storefrontRoute } from "../services/storefront/deps.server";
import { planJson, storefrontCurrency } from "../services/storefront/care-json.server";
import { presence, truncate } from "../services/storefront/json.server";

/**
 * GET /apps/repairs/care_plans?product_id=…&product_title=… →
 * /proxy/care_plans. The Care plans offered on a product page. The same for
 * every visitor (it never reads the customer), so the CDN keeps it per shop
 * and product. Port of Proxy::CareController#plans.
 */
export const loader = storefrontRoute({}, async (ctx) => {
  const shop = ctx.shopRecord;
  const plans = await activeCarePlans(shop.id);
  const productId = presence(ctx.params.get("product_id"));

  let facts: ProductFacts | null = null;
  if (productId && plans.length) {
    facts = plans.some(needsProductFacts)
      ? await new ProductFactsLoader(await ctx.deps.adminClient(ctx), {
          shopKey: shop.shopifyDomain,
        }).fetch(/\d+/.exec(productId)?.[0] ?? null)
      : emptyFacts(productId);
  }
  const eligible = facts ? plans.filter((plan) => appliesTo(plan, facts)) : [];
  const product = presence(truncate(ctx.params.get("product_title") ?? "", 120));
  const currency = storefrontCurrency(shop);
  return ctx.json(
    { ok: true, currency, plans: eligible.map((plan) => planJson(plan, { currency, product })) },
    {
      cache: {
        maxAge: 300,
        varyOn: ["product_id", "product_title"],
        tags: [`shop:${shop.shopifyDomain}`],
      },
    },
  );
});

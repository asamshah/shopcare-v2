import prisma from "../db.server";
import { searchCatalog } from "../shopify/catalog-search.server";
import { storefrontRoute } from "../services/storefront/deps.server";
import { compact } from "../services/storefront/json.server";

/**
 * GET /apps/repairs/catalog_search?q=… → /proxy/catalog_search. "Find the
 * product you bought": the shop's catalogue by name or SKU, public facts only,
 * so it's open to guests, CDN-cacheable per query, and rate-limited per
 * visitor and per shop. Port of Proxy::CatalogController.
 */
export const loader = storefrontRoute(
  { throttle: { name: "catalog", perIp: 60, perShop: 1200, periodSeconds: 60 } },
  async (ctx) => {
    const shop = ctx.shopRecord;
    const [services, plans] = await Promise.all([
      prisma.repairService.findMany({ where: { shopId: shop.id }, select: { shopifyVariantId: true } }),
      prisma.carePlan.findMany({ where: { shopId: shop.id }, select: { shopifyVariantId: true } }),
    ]);
    const excluded = [...services, ...plans]
      .map((row) => row.shopifyVariantId)
      .filter((id): id is string => Boolean(id));
    const results = await searchCatalog(await ctx.deps.adminClient(ctx), ctx.params.get("q"), {
      shopKey: shop.shopifyDomain,
      excludedVariantIds: excluded,
    });
    return ctx.json(
      {
        ok: true,
        results: results.map((result) =>
          compact({
            product_id: result.productId,
            product_title: result.productTitle,
            image_url: result.imageUrl,
            variant_id: result.variantId,
            variant_title: result.variantTitle,
            sku: result.sku,
            // Rails leaves nil keys inside each variant.
            variants: result.variants?.map((v) => ({
              variant_id: v.variantId,
              variant_title: v.variantTitle,
              sku: v.sku,
            })),
          }),
        ),
      },
      { cache: { maxAge: 300, varyOn: ["q"], tags: [`shop:${shop.shopifyDomain}`] } },
    );
  },
);

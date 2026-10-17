/**
 * The storefront data the Care offer block decides on without calling the
 * app (app/services/storefront/storefront-sync.server.ts): what's published,
 * where, and when it's republished and the CDN cache cleared.
 */
import type { Shop } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../../app/db.server";
import { pruneStaleRows } from "../../../app/jobs/daily-prune.server";
import { runJob } from "../../../app/jobs/registry.server";
import {
  buildStorefrontData,
  PRODUCT_TOKEN,
  setStorefrontSyncDeps,
  storefrontChanged,
  syncStorefront,
} from "../../../app/services/storefront/storefront-sync.server";
import { createCarePlanFor, createProductGroupFor, createShop } from "../../support/factories";
import { FakeGraphql } from "../../support/fake-graphql";

/** Shopify, with every Care variant at `prices[variant id]` (default 15.00; null = deleted). */
const fakeShopify = (prices: Record<string, string | null> = {}) =>
  new FakeGraphql({
    currentAppInstallation: { currentAppInstallation: { id: "gid://shopify/AppInstallation/1" } },
    metafieldsSet: { metafieldsSet: { metafields: [{ id: "gid://shopify/Metafield/1" }], userErrors: [] } },
    "productVariant(id:": ({ id }: Record<string, unknown>) => {
      const variantId = String(id).split("/").pop()!;
      const price = variantId in prices ? prices[variantId] : "15.00";
      return {
        productVariant:
          price === null
            ? null
            : { id, title: "Default Title", price, product: { id: "gid://shopify/Product/1", title: "2-year Care" } },
      };
    },
  });

describe("storefront data", () => {
  let shop: Shop;
  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    shop = await createShop({ shopifyDomain: "sync-test.myshopify.com" });
  });
  afterEach(() => {
    setStorefrontSyncDeps({});
    vi.restoreAllMocks();
  });

  it("lists the active plans with the product rules Liquid checks", async () => {
    const tagged = await createProductGroupFor(shop, { rule: "tags", tags: ["Boots", "Leather"] });
    const collections = await createProductGroupFor(shop, {
      rule: "collections",
      collections: [{ id: "gid://shopify/Collection/99", title: "Sale" }],
    });
    const typed = await createProductGroupFor(shop, { rule: "product_type", productType: "Bags" });
    await createCarePlanFor(shop, { name: "All", position: 1 });
    await createCarePlanFor(shop, { name: "Tagged", productGroupId: tagged.id, position: 2 });
    await createCarePlanFor(shop, { name: "In collection", productGroupId: collections.id, position: 3 });
    await createCarePlanFor(shop, { name: "Typed", productGroupId: typed.id, position: 4 });
    await createCarePlanFor(shop, { name: "Off", active: false, position: 5 });

    const data = await buildStorefrontData(shop);

    expect([data.v, data.currency]).toEqual([1, "GBP"]);
    expect(data.plans.map((p) => [p.name, p.rule])).toEqual([
      ["All", { type: "all" }],
      ["Tagged", { type: "tags", tags: ["boots", "leather"] }],
      ["In collection", { type: "collections", collection_ids: ["99"] }],
      ["Typed", { type: "product_type", product_type: "bags" }],
    ]);
    expect(data.plans[0].terms[0]).toContain(`your ${PRODUCT_TOKEN} for 2 years`);
  });

  it("publishes it as the app-data metafield and clears the shop's cached proxy responses", async () => {
    await createCarePlanFor(shop);
    const shopify = fakeShopify();
    const purge = vi.fn(async () => {});

    expect(await syncStorefront(shop.id, { client: async () => shopify, purge })).toBe("synced");

    const set = shopify.calls.find((c) => c.query.includes("metafieldsSet"))!;
    const [metafield] = set.variables.metafields as Record<string, string>[];
    expect([metafield.ownerId, metafield.namespace, metafield.key, metafield.type]).toEqual([
      "gid://shopify/AppInstallation/1",
      "shopcare",
      "storefront",
      "json",
    ]);
    expect(JSON.parse(metafield.value).plans).toHaveLength(1);
    expect(purge).toHaveBeenCalledWith(["shop:sync-test.myshopify.com"]);
  });

  it("refreshes each plan's price from its Shopify variant before publishing", async () => {
    const changed = await createCarePlanFor(shop, { shopifyVariantId: "7001", price: 15 });
    const same = await createCarePlanFor(shop, { shopifyVariantId: "7002", price: 9 });
    const deleted = await createCarePlanFor(shop, { shopifyVariantId: "7003", price: 5 });
    const shopify = fakeShopify({ "7001": "19.99", "7002": "9.00", "7003": null });

    await syncStorefront(shop.id, { client: async () => shopify, purge: async () => {} });

    const prices = await prisma.carePlan.findMany({ where: { id: { in: [changed.id, same.id, deleted.id] } }, orderBy: { id: "asc" } });
    expect(prices.map((p) => p.price.toFixed(2))).toEqual(["19.99", "9.00", "5.00"]);
    const set = shopify.calls.find((c) => c.query.includes("metafieldsSet"))!;
    const published = JSON.parse((set.variables.metafields as { value: string }[])[0].value);
    expect(published.plans.map((p: { price: string }) => p.price)).toEqual(["19.99", "9.00", "5.00"]);
  });

  it("still counts as synced when only the cache purge fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const purge = vi.fn(async () => {
      throw new Error("purge API down");
    });
    expect(await syncStorefront(shop.id, { client: async () => fakeShopify(), purge })).toBe("synced");
  });

  it("skips a shop that's uninstalled or has no offline session", async () => {
    expect(await syncStorefront(shop.id, { client: async () => null })).toBe("skipped");
    await prisma.shop.update({ where: { id: shop.id }, data: { uninstalledAt: new Date() } });
    expect(await syncStorefront(shop.id, { client: async () => fakeShopify() })).toBe("skipped");
  });

  it("storefrontChanged queues the job, and never throws", async () => {
    const enqueue = vi.fn(async () => {});
    await storefrontChanged(shop, enqueue);
    expect(enqueue).toHaveBeenCalledWith("storefront-sync", { shopId: shop.id });

    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(storefrontChanged(shop, async () => { throw new Error("db down"); })).resolves.toBeUndefined();
  });

  it("the daily prune republishes every installed shop", async () => {
    const shopify = fakeShopify();
    setStorefrontSyncDeps({ client: async () => shopify, purge: async () => {} });
    await createShop({ shopifyDomain: "gone.myshopify.com", uninstalledAt: new Date() });
    await pruneStaleRows(); // the rows part doesn't sync
    expect(shopify.calls).toHaveLength(0);

    await runJob("daily-prune", {});
    expect(shopify.calls.filter((c) => c.query.includes("metafieldsSet"))).toHaveLength(1);
  });
});

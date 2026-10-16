/** Port of Rails test/services/warranty/cover_assigner_test.rb. */
import type { Item, Shop } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import prisma from "../../../../app/db.server";
import { CoverAssigner } from "../../../../app/services/warranty/cover-assigner.server";
import { MemoryCache } from "../../../../app/shopify/cache.server";
import { ProductFactsLoader } from "../../../../app/shopify/product-facts.server";
import {
  createCarePlanFor,
  createItemFor,
  createProductGroupFor,
  createShop,
  createWarrantyPolicyFor,
  daysAgo,
} from "../../../support/factories";
import { FakeGraphql } from "../../../support/fake-graphql";

describe("CoverAssigner", () => {
  let shop: Shop;
  let item: Item;
  const facts = (api: FakeGraphql) =>
    new ProductFactsLoader(api, { shopKey: shop.shopifyDomain, cache: new MemoryCache() });

  beforeEach(async () => {
    shop = await createShop({ shopifyDomain: "ca-test.myshopify.com" });
    item = await createItemFor(shop, { productId: "10", productTitle: "Boot", purchasedAt: daysAgo(1) });
  });

  it("doesn't call Shopify when every policy covers all products", async () => {
    await createWarrantyPolicyFor(shop, { name: "All", months: 12 });
    const api = new FakeGraphql();

    const cover = await new CoverAssigner(shop, facts(api)).assign(item);

    expect(cover?.terms).toMatchObject({ name: "All" });
    expect(api.calls).toHaveLength(0);
  });

  it("uses product facts from Shopify for filtered policies, and notes eligible Care plans", async () => {
    const group = await createProductGroupFor(shop, {
      name: "Leather",
      rule: "collections",
      collections: [{ id: "gid://shopify/Collection/77", title: "Leather" }],
    });
    await createWarrantyPolicyFor(shop, { name: "Leather", months: 24, productGroupId: group.id });
    const plan = await createCarePlanFor(shop, { productGroupId: group.id });
    const api = new FakeGraphql({
      "product(id:": {
        product: {
          id: "gid://shopify/Product/10",
          title: "Boot",
          productType: "Boots",
          tags: [],
          collections: { nodes: [{ id: "gid://shopify/Collection/77" }] },
        },
      },
    });

    const cover = await new CoverAssigner(shop, facts(api)).assign(item);

    expect(cover?.terms).toMatchObject({ name: "Leather" });
    const saved = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(saved.eligibleCarePlanIds).toEqual([plan.id]);
  });

  it("no policies, no cover", async () => {
    expect(await new CoverAssigner(shop, null).assign(item)).toBeNull();
  });
});

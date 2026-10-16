// Port of Rails test/models/product_group_test.rb.
import type { Shop } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
import type { ProductFacts } from "../../../app/models/product-facts";
import {
  createProductGroup,
  deleteProductGroup,
  groupCollections,
  groupTags,
  type ProductGroupInput,
  productGroupCollectionIds,
  productGroupMatches,
} from "../../../app/models/product-group.server";
import { ValidationError } from "../../../app/models/validation.server";
import { createShop, createWarrantyPolicyFor } from "../../support/factories";

describe("ProductGroup", () => {
  let shop: Shop;
  const boot: ProductFacts = {
    productId: "1",
    productType: "Boots",
    tags: ["Leather", "core"],
    collectionIds: ["77"],
  };

  async function group(attrs: Partial<ProductGroupInput>) {
    const count = await prisma.productGroup.count({ where: { shopId: shop.id } });
    return createProductGroup({ shopId: shop.id, name: `Group ${count + 1}`, ...attrs });
  }

  beforeEach(async () => {
    shop = await createShop({ shopifyDomain: "pg-test.myshopify.com" });
  });

  it("matches by collections, tags and type, case-insensitively; any value is enough", async () => {
    expect(productGroupMatches(await group({ rule: "all" }), boot)).toBe(true);
    expect(
      productGroupMatches(
        await group({
          rule: "collections",
          collections: [
            { id: "gid://shopify/Collection/5", title: "Sale" },
            { id: "gid://shopify/Collection/77", title: "Leather" },
          ],
        }),
        boot,
      ),
    ).toBe(true);
    expect(
      productGroupMatches(
        await group({ rule: "collections", collections: [{ id: "gid://shopify/Collection/5", title: "Sale" }] }),
        boot,
      ),
    ).toBe(false);
    expect(productGroupMatches(await group({ rule: "tags", tags: ["suede", "LEATHER"] }), boot)).toBe(true);
    expect(productGroupMatches(await group({ rule: "tags", tags: ["suede"] }), boot)).toBe(false);
    expect(productGroupMatches(await group({ rule: "product_type", productType: "boots" }), boot)).toBe(true);
    expect(productGroupMatches(await group({ rule: "product_type", productType: "Sandals" }), boot)).toBe(false);
  });

  it("keeps only the rule's values, tidied", async () => {
    const tags = await group({
      rule: "tags",
      tags: [" leather ", "", "Leather", "core"],
      productType: "Boots",
      collections: [{ id: "77", title: "x" }],
    });
    expect([groupTags(tags), groupCollections(tags), tags.productType]).toEqual([["leather", "core"], [], null]);

    const collections = await group({
      rule: "collections",
      collections: [{ id: "77" }, { id: "gid://shopify/Collection/77" }, { id: "junk" }],
    });
    expect(groupCollections(collections)).toEqual([
      { id: "gid://shopify/Collection/77", title: "Collection 77" },
    ]);
    expect(productGroupCollectionIds(collections)).toEqual(["77"]);
  });

  it("each rule needs its values; names are unique per shop", async () => {
    for (const rule of ["tags", "collections", "product_type", "nope"]) {
      await expect(createProductGroup({ shopId: shop.id, name: "A", rule })).rejects.toThrow(ValidationError);
    }

    await group({ name: "Leather", rule: "all" });
    await expect(createProductGroup({ shopId: shop.id, name: "leather", rule: "all" })).rejects.toThrow(
      /has already been taken/,
    );
  });

  it("a group in use can't be deleted", async () => {
    const leather = await group({ rule: "tags", tags: ["leather"] });
    await createWarrantyPolicyFor(shop, { name: "W", months: 12, productGroupId: leather.id });

    expect(await deleteProductGroup(leather.id)).toBe(false);
    expect(await prisma.productGroup.findUnique({ where: { id: leather.id } })).not.toBeNull();
  });
});

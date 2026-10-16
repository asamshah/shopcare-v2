// Port of Rails test/models/warranty_policy_test.rb.
import type { Shop } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
import type { ProductFacts } from "../../../app/models/product-facts";
import { createProductGroup, type ProductGroupInput } from "../../../app/models/product-group.server";
import { appliesTo, needsProductFacts } from "../../../app/models/product-grouped.server";
import {
  createWarrantyPolicy,
  customerSummary,
  effectiveDiscountPercent,
  matchingWarrantyPolicy,
  type WarrantyPolicyInput,
  warrantyTermsSnapshot,
} from "../../../app/models/warranty-policy.server";
import { ValidationError } from "../../../app/models/validation.server";
import { createShop } from "../../support/factories";

describe("WarrantyPolicy", () => {
  let shop: Shop;
  const boot: ProductFacts = {
    productId: "1",
    productType: "Boots",
    tags: ["Leather", "core"],
    collectionIds: ["77"],
  };

  /** Creates a policy and returns it with its group loaded. */
  async function policy(attrs: Partial<WarrantyPolicyInput> = {}) {
    const created = await createWarrantyPolicy({ shopId: shop.id, name: "Warranty", months: 12, ...attrs });
    return prisma.warrantyPolicy.findUniqueOrThrow({
      where: { id: created.id },
      include: { productGroup: true },
    });
  }

  async function group(attrs: Partial<ProductGroupInput>) {
    const count = await prisma.productGroup.count({ where: { shopId: shop.id } });
    return createProductGroup({ shopId: shop.id, name: `Group ${count + 1}`, ...attrs });
  }

  beforeEach(async () => {
    shop = await createShop({ shopifyDomain: "wp-test.myshopify.com" });
  });

  it("applies to all products without a group, otherwise to the group's products", async () => {
    const all = await policy();
    expect(appliesTo(all, boot)).toBe(true);
    expect(needsProductFacts(all)).toBe(false);
    expect(appliesTo(await policy({ productGroupId: (await group({ rule: "tags", tags: ["leather"] })).id }), boot)).toBe(true);
    expect(appliesTo(await policy({ productGroupId: (await group({ rule: "tags", tags: ["suede"] })).id }), boot)).toBe(false);
    expect(needsProductFacts(await policy({ productGroupId: (await group({ rule: "tags", tags: ["suede"] })).id }))).toBe(true);
  });

  it("a policy can't use another shop's group", async () => {
    const other = await createShop({ shopifyDomain: "wp-other.myshopify.com" });
    const foreign = await createProductGroup({ shopId: other.id, name: "Theirs", rule: "all" });

    await expect(
      createWarrantyPolicy({ shopId: shop.id, name: "W", months: 12, productGroupId: foreign.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("the first active policy by position wins", async () => {
    await policy({ name: "Leather", position: 1, productGroupId: (await group({ rule: "tags", tags: ["leather"] })).id });
    await policy({ name: "Everything", position: 2 });
    await policy({ name: "Retired", position: 0, active: false });

    expect((await matchingWarrantyPolicy(shop.id, boot))?.name).toBe("Leather");
  });

  it("a free outcome is always 100% off", async () => {
    const free = await policy({ outcome: "free", discountPercent: 30 });
    const discounted = await policy({ outcome: "discount", discountPercent: 30 });

    expect(effectiveDiscountPercent(free).toNumber()).toBe(100);
    expect(effectiveDiscountPercent(discounted).toNumber()).toBe(30);
  });

  it("the customer summary ends with the statutory rights sentence", async () => {
    expect(
      customerSummary(
        await policy({ months: 24, outcome: "discount", discountPercent: 25, coveredFaults: "Sole separation" }),
      ),
    ).toEqual([
      "25% off repairs for 24 months from the date you bought your item.",
      "Covers: Sole separation.",
      "This warranty is in addition to, and does not affect, your statutory rights.",
    ]);
  });

  it("terms snapshot captures what the customer was given", async () => {
    const terms = warrantyTermsSnapshot(
      await policy({ outcome: "discount", discountPercent: 25, coveredFaults: "Sole separation\n\nStitching\n" }),
    );

    expect(terms.discount_percent).toBe(25.0);
    expect(terms.covered_faults).toEqual(["Sole separation", "Stitching"]);
  });
});

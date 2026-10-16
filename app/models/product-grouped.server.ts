/**
 * Which products a warranty policy or Care plan applies to: those in its
 * product group, or all products when it has none. Port of the ProductGrouped
 * concern. Pass the record with its `productGroup` loaded (null for none).
 */
import type { ProductGroup } from "@prisma/client";
import type { Db } from "../lib/db-lock.server";
import type { ProductFacts } from "./product-facts";
import { productGroupMatches, productGroupNeedsFacts } from "./product-group.server";
import type { Errors } from "./validation.server";

export interface Grouped {
  productGroup: ProductGroup | null;
}

export function appliesTo(record: Grouped, facts: ProductFacts): boolean {
  return record.productGroup === null || productGroupMatches(record.productGroup, facts);
}

export function needsProductFacts(record: Grouped): boolean {
  return record.productGroup ? productGroupNeedsFacts(record.productGroup) : false;
}

export function eligibilitySummary(record: Grouped): string {
  return record.productGroup ? record.productGroup.name : "All products";
}

/** Rails `validate :product_group_belongs_to_shop`. */
export async function validateProductGroupBelongsToShop(
  errors: Errors,
  db: Db,
  shopId: number,
  productGroupId: number | null | undefined,
): Promise<void> {
  if (!productGroupId) return;
  const group = await db.productGroup.findUnique({
    where: { id: productGroupId },
    select: { shopId: true },
  });
  if (group && group.shopId !== shopId) {
    errors.add("productGroup", "isn't one of this shop's groups");
  }
}

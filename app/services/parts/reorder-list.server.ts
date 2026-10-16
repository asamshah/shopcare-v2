/**
 * Part variants at or below their reorder level, with how much to buy. No
 * purchase orders: the merchant's buyers work from this list / CSV. Port of
 * Parts::ReorderList.
 */
import { Prisma, type Part, type PartVariant } from "@prisma/client";
import prisma from "../../db.server";
import { generateCsv } from "../../lib/csv";
import type { Db } from "../../lib/db-lock.server";
import { lowVariantIds, variantLabel } from "../../models/part-variant.server";

export interface ReorderRow {
  variant: PartVariant & { part: Part };
  suggestedUnits: Prisma.Decimal;
  suggestedPacks: number;
}

export async function reorderRows(shopId: number, db: Db = prisma): Promise<ReorderRow[]> {
  const ids = await lowVariantIds(shopId, db);
  const variants = await db.partVariant.findMany({
    where: { id: { in: ids }, part: { shopId, active: true } },
    include: { part: true },
    orderBy: [{ part: { name: "asc" } }, { id: "asc" }],
  });
  return variants.map((variant) => {
    const { part } = variant;
    // Bring stock back up to reorder level + reorder quantity, in whole packs.
    const units = Prisma.Decimal.max(
      part.reorderLevel.add(part.reorderQuantity).sub(variant.onHand),
      0,
    );
    const packs = units.div(part.packSize).ceil().toNumber();
    return { variant, suggestedPacks: packs, suggestedUnits: part.packSize.mul(packs) };
  });
}

/** Ruby BigDecimal#to_s("F"): always one decimal place at least ("150.0"). */
const f = (value: Prisma.Decimal) => {
  const text = value.toString();
  return text.includes(".") ? text : `${text}.0`;
};

export async function reorderCsv(shopId: number, db: Db = prisma): Promise<string> {
  const rows = await reorderRows(shopId, db);
  return generateCsv([
    ["Part", "Variant", "SKU", "Unit", "On hand", "Reorder level", "Pack size", "Packs to order", "Units to order", "Unit cost"],
    ...rows.map(({ variant, suggestedPacks, suggestedUnits }) => {
      const { part } = variant;
      return [
        part.name,
        variantLabel(variant, part),
        variant.sku?.trim() ? variant.sku : part.sku,
        part.unit,
        f(variant.onHand),
        f(part.reorderLevel),
        f(part.packSize),
        suggestedPacks,
        f(suggestedUnits),
        f(part.costPerUnit),
      ];
    }),
  ]);
}

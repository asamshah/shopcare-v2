/** One stockable version of a part, e.g. a Commando sole in UK 7, black. Port of PartVariant. */
import { Prisma, type Part, type PartVariant, type StockMovement } from "@prisma/client";
import prisma from "../db.server";
import { type Db, inTransaction, withRowLock } from "../lib/db-lock.server";
import { createStockMovement, type StockMovementReason } from "./stock-movement.server";
import { assertValid, type DecimalInput, Errors, jsonArray, jsonObject } from "./validation.server";

export interface PartVariantInput {
  partId: number;
  options?: Record<string, string>;
  sku?: string | null;
  onHand?: DecimalInput;
}

const optionNamesOf = (part: Pick<Part, "optionNames">) => jsonArray(part.optionNames).map(String);

export const variantOptions = (variant: Pick<PartVariant, "options">) =>
  jsonObject(variant.options) as Record<string, string>;

/** Compare option values loosely: case and surrounding/repeated spaces don't matter. */
export function normalizeOptionValue(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/ +/g, " ");
}

export function validatePartVariant(
  options: Record<string, unknown>,
  part: Pick<Part, "optionNames"> | null,
): Errors {
  const errors = new Errors();
  if (!part) return errors;
  const names = optionNamesOf(part);
  const keys = Object.keys(options).sort();
  const matches =
    JSON.stringify(keys) === JSON.stringify([...names].sort()) &&
    Object.values(options).every((value) => String(value ?? "").trim() !== "");
  if (!matches) errors.add("options", `must set ${names.join(", ")}`);
  return errors;
}

export async function createPartVariant(
  input: PartVariantInput,
  db: Db = prisma,
): Promise<PartVariant> {
  const part = await db.part.findUnique({ where: { id: input.partId } });
  const options = input.options ?? {};
  assertValid("PartVariant", validatePartVariant(options, part));
  return db.partVariant.create({ data: { ...input, options } });
}

export function variantLabel(variant: Pick<PartVariant, "options">, part: Pick<Part, "optionNames">): string {
  const options = variantOptions(variant);
  const values = optionNamesOf(part)
    .map((name) => options[name])
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== "");
  return values.length ? values.join(" · ") : "Standard";
}

export function variantFullLabel(
  variant: Pick<PartVariant, "options">,
  part: Pick<Part, "optionNames" | "name">,
): string {
  return optionNamesOf(part).length > 0 ? `${part.name} (${variantLabel(variant, part)})` : part.name;
}

export function variantMatches(variant: Pick<PartVariant, "options">, option: string, value: unknown): boolean {
  return normalizeOptionValue(variantOptions(variant)[option]) === normalizeOptionValue(value);
}

export function variantLow(variant: Pick<PartVariant, "onHand">, part: Pick<Part, "reorderLevel">): boolean {
  return new Prisma.Decimal(variant.onHand).lte(part.reorderLevel);
}

/** Ids of variants at or below their part's reorder level (Rails `scope :low`). */
export async function lowVariantIds(shopId: number, db: Db = prisma): Promise<number[]> {
  const rows = await db.$queryRaw<{ id: number }[]>`
    SELECT part_variants.id FROM part_variants
    JOIN parts ON parts.id = part_variants.part_id
    WHERE parts.shop_id = ${shopId} AND part_variants.on_hand <= parts.reorder_level`;
  return rows.map((row) => row.id);
}

/**
 * Moves stock and records why, under a row lock on the variant. `quantity` is
 * signed, in the part's unit; the movement captures the part's unit cost.
 */
export function moveStock(
  variantId: number,
  quantity: DecimalInput,
  {
    reason,
    repairTicketId = null,
    note = null,
    by = null,
  }: {
    reason: StockMovementReason | string;
    repairTicketId?: number | null;
    note?: string | null;
    by?: string | null;
  },
  db: Db = prisma,
): Promise<StockMovement> {
  return inTransaction(db, async (tx) => {
    await withRowLock(tx, "part_variants", variantId);
    const variant = await tx.partVariant.findUniqueOrThrow({
      where: { id: variantId },
      include: { part: true },
    });
    const amount = new Prisma.Decimal(quantity);
    await tx.partVariant.update({
      where: { id: variantId },
      data: { onHand: new Prisma.Decimal(variant.onHand).add(amount) },
    });
    return createStockMovement(
      {
        shopId: variant.part.shopId,
        partVariantId: variantId,
        quantity: amount,
        reason,
        repairTicketId,
        unitCost: variant.part.costPerUnit,
        note,
        createdBy: by,
      },
      tx,
    );
  });
}

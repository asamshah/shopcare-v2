/**
 * CSVs for the merchant's parts spreadsheet. Port of Parts::CsvExport:
 *   parts      one row per variant, in the import's columns with today's
 *              on_hand, so it can be edited and imported back
 *   stockUsed  every stock movement between two dates (used on repairs,
 *              received, counted), to update the spreadsheet with
 */
import { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import { generateCsv } from "../../lib/csv";
import type { Db } from "../../lib/db-lock.server";
import { ORDERED } from "../../models/part.server";
import { variantLabel, variantOptions } from "../../models/part-variant.server";
import { CSV_COLUMNS } from "./csv-import.server";

export const STOCK_COLUMNS = [
  "date", "part_name", "part_sku", "variant", "variant_sku", "quantity", "unit", "reason", "ticket", "note",
];

/** 12.5, not 12.5000 */
const number = (value: Prisma.Decimal) => new Prisma.Decimal(value).toString();

export async function exportParts(shopId: number, db: Db = prisma): Promise<string> {
  const parts = await db.part.findMany({
    where: { shopId },
    orderBy: ORDERED,
    include: { variants: { orderBy: { id: "asc" } } },
  });
  const rows: unknown[][] = [CSV_COLUMNS];
  for (const part of parts) {
    // A part waiting for its variants still gets a row.
    const variants = part.variants.length ? part.variants : [null];
    for (const variant of variants) {
      const options = variant ? variantOptions(variant) : {};
      rows.push([
        part.name, part.sku, part.unit, number(part.packSize), number(part.costPerUnit),
        number(part.reorderLevel), number(part.reorderQuantity),
        options.model, options.size, options.colour,
        variant?.sku, variant ? number(variant.onHand) : null,
      ]);
    }
  }
  return generateCsv(rows);
}

const startOfDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

export async function exportStockUsed(
  shopId: number,
  { from, to }: { from: Date; to: Date },
  db: Db = prisma,
): Promise<string> {
  const end = new Date(startOfDay(to).getTime() + 86_400_000 - 1);
  const movements = await db.stockMovement.findMany({
    where: { shopId, createdAt: { gte: startOfDay(from), lte: end } },
    include: { partVariant: { include: { part: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return generateCsv([
    STOCK_COLUMNS,
    ...movements.map((m) => {
      const variant = m.partVariant;
      const part = variant.part;
      return [
        m.createdAt.toISOString().slice(0, 10), part.name, part.sku, variantLabel(variant, part), variant.sku,
        number(m.quantity), part.unit, m.reason, m.repairTicketId ? `#${m.repairTicketId}` : null, m.note,
      ];
    }),
  ]);
}

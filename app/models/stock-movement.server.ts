/**
 * Why stock changed: received (bought in), consumed (used on a repair),
 * adjusted (a stock count in the app) or stock_count (on-hand set from the
 * merchant's spreadsheet). Quantities are signed, in the part's unit. Port of
 * StockMovement.
 */
import type { Prisma, StockMovement } from "@prisma/client";
import prisma from "../db.server";
import type { Db } from "../lib/db-lock.server";
import { assertValid, Errors, validateInclusion, validateNumber } from "./validation.server";

export const STOCK_MOVEMENT_REASONS = ["received", "consumed", "adjusted", "stock_count"] as const;
export type StockMovementReason = (typeof STOCK_MOVEMENT_REASONS)[number];

export function validateStockMovement(
  movement: Pick<Prisma.StockMovementUncheckedCreateInput, "quantity" | "reason">,
): Errors {
  const errors = new Errors();
  validateInclusion(errors, "reason", movement.reason, STOCK_MOVEMENT_REASONS);
  validateNumber(errors, "quantity", movement.quantity, { otherThan: 0 });
  return errors;
}

export async function createStockMovement(
  data: Prisma.StockMovementUncheckedCreateInput,
  db: Db = prisma,
): Promise<StockMovement> {
  assertValid("StockMovement", validateStockMovement(data));
  return db.stockMovement.create({ data });
}

export const RECENT_ORDER: Prisma.StockMovementOrderByWithRelationInput[] = [
  { createdAt: "desc" },
  { id: "desc" },
];

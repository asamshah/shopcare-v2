/**
 * A Shopify refund `refunds/create` has already applied, so a retried or late
 * duplicate delivery isn't applied twice. Port of ProcessedRefund.
 */
import type { Prisma, ProcessedRefund } from "@prisma/client";
import prisma from "../db.server";
import type { Db } from "../lib/db-lock.server";
import { assertValid, Errors, validatePresence } from "./validation.server";

export function validateProcessedRefund(
  data: Pick<Prisma.ProcessedRefundUncheckedCreateInput, "refundId">,
): Errors {
  const errors = new Errors();
  validatePresence(errors, "refundId", data.refundId);
  return errors;
}

export async function createProcessedRefund(
  data: Prisma.ProcessedRefundUncheckedCreateInput,
  db: Db = prisma,
): Promise<ProcessedRefund> {
  assertValid("ProcessedRefund", validateProcessedRefund(data));
  return db.processedRefund.create({ data });
}

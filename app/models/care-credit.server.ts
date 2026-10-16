/**
 * A discount code worth a refunded Care plan, offered instead of a refund so
 * the customer can put it towards Care for another product, or an upgrade.
 * Port of CareCredit.
 */
import type { CareCredit, Prisma } from "@prisma/client";
import prisma from "../db.server";
import type { Db } from "../lib/db-lock.server";
import { assertValid, Errors, validatePresence } from "./validation.server";

export async function validateCareCredit(
  data: Pick<Prisma.CareCreditUncheckedCreateInput, "code" | "amount" | "coverId">,
  db: Db = prisma,
): Promise<Errors> {
  const errors = new Errors();
  validatePresence(errors, "code", data.code);
  validatePresence(errors, "amount", data.amount);
  // One credit per refunded Care plan (also a unique index).
  if (await db.careCredit.findUnique({ where: { coverId: data.coverId }, select: { id: true } })) {
    errors.add("coverId", "has already been taken");
  }
  return errors;
}

export async function createCareCredit(
  data: Prisma.CareCreditUncheckedCreateInput,
  db: Db = prisma,
): Promise<CareCredit> {
  assertValid("CareCredit", await validateCareCredit(data, db));
  return db.careCredit.create({ data });
}

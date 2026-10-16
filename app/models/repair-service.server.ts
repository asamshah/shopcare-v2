/**
 * A repair the workshop offers, mirroring one of the merchant's Shopify repair
 * products (variant). ShopCare adds what Shopify doesn't know: labour time and
 * the recipe of parts it uses. Port of RepairService.
 */
import { Prisma, type RepairService } from "@prisma/client";
import prisma from "../db.server";
import type { Db } from "../lib/db-lock.server";
import { assertValid, Errors, validateNumber, validatePresence } from "./validation.server";

export function validateRepairService(
  s: Pick<Prisma.RepairServiceUncheckedCreateInput, "title" | "shopifyVariantId" | "labourMinutes">,
): Errors {
  const errors = new Errors();
  validatePresence(errors, "title", s.title);
  validatePresence(errors, "shopifyVariantId", s.shopifyVariantId);
  validateNumber(errors, "labourMinutes", s.labourMinutes ?? 0, {
    onlyInteger: true,
    greaterThanOrEqualTo: 0,
  });
  return errors;
}

export async function createRepairService(
  data: Prisma.RepairServiceUncheckedCreateInput,
  db: Db = prisma,
): Promise<RepairService> {
  assertValid("RepairService", validateRepairService(data));
  return db.repairService.create({ data });
}

export async function updateRepairService(
  id: number,
  data: Prisma.RepairServiceUncheckedUpdateInput,
  db: Db = prisma,
): Promise<RepairService> {
  const current = await db.repairService.findUniqueOrThrow({ where: { id } });
  assertValid(
    "RepairService",
    validateRepairService({ ...current, ...data } as Prisma.RepairServiceUncheckedCreateInput),
  );
  return db.repairService.update({ where: { id }, data });
}

/** Parts cost of one service at today's unit costs. */
export async function partsCost(serviceId: number, db: Db = prisma): Promise<Prisma.Decimal> {
  const components = await db.serviceComponent.findMany({
    where: { repairServiceId: serviceId },
    include: { part: true },
  });
  return components.reduce(
    (sum, c) => sum.add(new Prisma.Decimal(c.quantity).mul(c.part.costPerUnit)),
    new Prisma.Decimal(0),
  );
}

export const ORDERED: Prisma.RepairServiceOrderByWithRelationInput[] = [
  { title: "asc" },
  { id: "asc" },
];

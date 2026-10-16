/**
 * A part planned for (and later used on) a repair ticket. Planned from the
 * quote's services' recipes or added by hand; stock is taken when the ticket
 * is completed, and `unitCost` captured then for the margin. Port of TicketPart.
 */
import { Prisma, type Part, type TicketPart } from "@prisma/client";
import prisma from "../db.server";
import type { Db } from "../lib/db-lock.server";
import { assertValid, Errors, validateNumber } from "./validation.server";

export async function validateTicketPart(
  data: Pick<Prisma.TicketPartUncheckedCreateInput, "quantity" | "partId" | "partVariantId">,
  db: Db = prisma,
): Promise<Errors> {
  const errors = new Errors();
  validateNumber(errors, "quantity", data.quantity ?? 1, { greaterThan: 0 });
  if (data.partVariantId) {
    const variant = await db.partVariant.findUnique({
      where: { id: data.partVariantId },
      select: { partId: true },
    });
    if (variant && variant.partId !== data.partId) {
      const part = await db.part.findUnique({ where: { id: data.partId }, select: { name: true } });
      errors.add("partVariant", `must be a variant of ${part?.name ?? ""}`);
    }
  }
  return errors;
}

export async function createTicketPart(
  data: Prisma.TicketPartUncheckedCreateInput,
  db: Db = prisma,
): Promise<TicketPart> {
  assertValid("TicketPart", await validateTicketPart(data, db));
  return db.ticketPart.create({ data });
}

export const unconsumedWhere: Prisma.TicketPartWhereInput = { consumedAt: null };

export const isConsumed = (tp: Pick<TicketPart, "consumedAt">) => tp.consumedAt !== null;

/** quantity × (captured unit cost, or the part's current cost). */
export function ticketPartCost(
  tp: Pick<TicketPart, "quantity" | "unitCost">,
  part: Pick<Part, "costPerUnit">,
): Prisma.Decimal {
  return new Prisma.Decimal(tp.quantity).mul(tp.unitCost ?? part.costPerUnit);
}

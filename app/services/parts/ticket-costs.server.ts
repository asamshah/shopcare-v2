/**
 * What a repair cost (parts used + labour) against what was charged. Stored
 * on the ticket at completion; it's the data Care plan pricing is built from.
 * Port of Parts::TicketCosts.
 */
import { Prisma, type RepairTicket } from "@prisma/client";
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import { currentQuotation } from "../../models/repair-ticket.server";
import { labourRate } from "../../models/shop.server";
import { ticketPartCost } from "../../models/ticket-part.server";

/** Ruby BigDecimal#to_s("F"): "12.0", "0.25". */
const f = (value: Prisma.Decimal) => {
  const text = value.toString();
  return text.includes(".") ? text : `${text}.0`;
};

export async function ticketCosts(
  ticket: Pick<RepairTicket, "id" | "shopId">,
  { db = prisma, now = new Date() }: { db?: Db; now?: Date } = {},
): Promise<Record<string, string | number | null>> {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: ticket.shopId } });
  const parts = (
    await db.ticketPart.findMany({ where: { repairTicketId: ticket.id }, include: { part: true } })
  )
    .reduce((sum, tp) => sum.add(ticketPartCost(tp, tp.part)), new Prisma.Decimal(0))
    .toDecimalPlaces(2);

  const quotation = await currentQuotation(ticket.id, db);
  let minutes = 0;
  if (quotation) {
    const lines = await db.quotationLineItem.findMany({
      where: { quotationId: quotation.id, shopifyVariantId: { not: null } },
    });
    const services = await db.repairService.findMany({
      where: { shopId: ticket.shopId, shopifyVariantId: { in: lines.map((l) => l.shopifyVariantId!) } },
    });
    const byVariant = new Map(services.map((s) => [s.shopifyVariantId, s.labourMinutes]));
    minutes = lines.reduce(
      (sum, line) => sum + (byVariant.get(line.shopifyVariantId!) ?? 0) * line.quantity,
      0,
    );
  }
  const labour = labourRate(shop).mul(minutes).div(60).toDecimalPlaces(2);
  const price =
    quotation?.status === "paid" ? new Prisma.Decimal(quotation.subtotal) : new Prisma.Decimal(0);
  return {
    parts: f(parts),
    labour_minutes: minutes,
    labour: f(labour),
    price: f(price),
    margin: f(price.sub(parts).sub(labour).toDecimalPlaces(2)),
    currency: quotation?.currency ?? null,
    calculated_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

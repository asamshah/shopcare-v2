/**
 * When a repair is completed: takes its parts out of stock (planning them
 * from the recipe first if staff never did) and records what the repair
 * really cost. Parts with no variant chosen can't be taken from stock;
 * they're reported so staff can fix them. Port of Parts::Consumer.
 *
 * Each part is consumed in its own transaction (stock moved under the
 * variant's row lock, then the ticket part stamped), and only unconsumed
 * parts are picked up, so running it twice doesn't take stock twice.
 */
import type { Part, RepairTicket, TicketPart } from "@prisma/client";
import prisma from "../../db.server";
import { inTransaction, withRowLock, type Db } from "../../lib/db-lock.server";
import { toSentence } from "../../lib/inflections";
import { moveStock } from "../../models/part-variant.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";
import { planTicketParts } from "./planner.server";
import { ticketCosts } from "./ticket-costs.server";

export interface ConsumeResult {
  consumed: (TicketPart & { part: Part })[];
  skipped: (TicketPart & { part: Part })[];
  /** "Commando sole and Adhesive" */
  skippedNames: string;
}

export async function consumeTicketParts(
  ticket: Pick<RepairTicket, "id" | "shopId" | "itemId">,
  {
    by = "system",
    db = prisma,
    client = null,
    now = new Date(),
  }: { by?: string; db?: Db; client?: AdminGraphqlClient | null; now?: Date } = {},
): Promise<ConsumeResult> {
  if ((await db.ticketPart.count({ where: { repairTicketId: ticket.id } })) === 0) {
    await planTicketParts(
      { shopId: ticket.shopId, ticketId: ticket.id },
      { db, client: client ?? undefined },
    );
  }
  const parts = await db.ticketPart.findMany({
    where: { repairTicketId: ticket.id, consumedAt: null },
    include: { part: true },
    orderBy: { id: "asc" },
  });
  const consumed = parts.filter((tp) => tp.partVariantId !== null);
  const skipped = parts.filter((tp) => tp.partVariantId === null);
  for (const tp of consumed) {
    await inTransaction(db, async (tx) => {
      await withRowLock(tx, "ticket_parts", tp.id);
      const fresh = await tx.ticketPart.findUniqueOrThrow({ where: { id: tp.id } });
      if (fresh.consumedAt) return; // a concurrent completion took it already
      await moveStock(
        tp.partVariantId!,
        tp.quantity.neg(),
        { reason: "consumed", repairTicketId: ticket.id, note: `Ticket #${ticket.id}`, by },
        tx,
      );
      await tx.ticketPart.update({
        where: { id: tp.id },
        data: { consumedAt: now, unitCost: tp.part.costPerUnit },
      });
    });
  }
  await db.repairTicket.update({
    where: { id: ticket.id },
    data: { costs: await ticketCosts(ticket, { db, now }) },
  });
  return { consumed, skipped, skippedNames: toSentence(skipped.map((tp) => tp.part.name)) };
}

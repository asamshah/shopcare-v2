/**
 * Plans a ticket's parts from the repair services on its quote: each service's
 * recipe × the quantity quoted, matched to variants using the item's size,
 * model and colour. Re-planning replaces recipe parts not yet used; parts
 * staff added by hand are kept. Port of Parts::Planner.
 *
 * The item's properties come from Shopify the first time (itemProperties);
 * pass `properties` to skip that, or a `client` to allow it.
 */
import type { Part, TicketPart } from "@prisma/client";
import prisma from "../../db.server";
import { type Db, inTransaction } from "../../lib/db-lock.server";
import { currentQuotation } from "../../models/repair-ticket.server";
import { createTicketPart } from "../../models/ticket-part.server";
import { jsonObject } from "../../models/validation.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";
import { itemProperties } from "./item-properties.server";
import { matchComponent } from "./matcher.server";

export type PlannedPart = TicketPart & { part: Part };

export async function planTicketParts(
  { shopId, ticketId }: { shopId: number; ticketId: number },
  {
    db = prisma,
    client,
    properties,
  }: { db?: Db; client?: AdminGraphqlClient; properties?: Record<string, unknown> } = {},
): Promise<PlannedPart[]> {
  const ticket = await db.repairTicket.findFirstOrThrow({
    where: { id: ticketId, shopId },
    include: { item: true, shop: true },
  });
  const quotation = await currentQuotation(ticket.id, db);
  const lines = quotation
    ? await db.quotationLineItem.findMany({
        where: { quotationId: quotation.id, shopifyVariantId: { not: null } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    : [];
  const services = await db.repairService.findMany({
    where: { shopId, shopifyVariantId: { in: lines.map((l) => l.shopifyVariantId as string) } },
    include: {
      components: { orderBy: { id: "asc" }, include: { part: { include: { variants: true } } } },
    },
  });
  const byVariant = new Map(services.map((s) => [s.shopifyVariantId, s]));
  const serviceLines = lines.flatMap((line) => {
    const service = byVariant.get(line.shopifyVariantId as string);
    return service ? [{ service, quantity: line.quantity }] : [];
  });

  let props = properties;
  if (!props) {
    if (!ticket.item) props = {};
    else if (client) props = await itemProperties(ticket.shop, client, ticket.item, { db });
    else props = jsonObject(ticket.item.properties);
  }

  return inTransaction(db, async (tx) => {
    await tx.ticketPart.deleteMany({
      where: { repairTicketId: ticket.id, consumedAt: null, repairServiceId: { not: null } },
    });
    const planned: PlannedPart[] = [];
    for (const { service, quantity } of serviceLines) {
      for (const component of service.components) {
        const match = matchComponent(component, props);
        const created = await createTicketPart(
          {
            repairTicketId: ticket.id,
            partId: component.partId,
            partVariantId: match.variant?.id ?? null,
            repairServiceId: service.id,
            quantity: component.quantity.mul(quantity),
          },
          tx,
        );
        planned.push({ ...created, part: component.part });
      }
    }
    return planned;
  });
}

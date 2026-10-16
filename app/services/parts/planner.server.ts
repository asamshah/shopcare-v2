/**
 * Plans a ticket's parts from the repair services on its quote: each
 * service's recipe × the quantity quoted, matched to variants using the
 * item's size, model and colour. Re-planning replaces recipe parts not yet
 * used; parts staff added by hand are kept. Port of Parts::Planner.
 */
import type { RepairTicket, Shop, TicketPart } from "@prisma/client";
import prisma from "../../db.server";
import { inTransaction, type Db } from "../../lib/db-lock.server";
import { currentQuotation } from "../../models/repair-ticket.server";
import { createTicketPart } from "../../models/ticket-part.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";
import { itemProperties } from "./item-properties.server";
import { matchComponent } from "./matcher.server";

export async function planTicketParts(
  ticket: Pick<RepairTicket, "id" | "shopId" | "itemId">,
  {
    db = prisma,
    client,
    properties,
  }: {
    db?: Db;
    /** Reads the item's properties from Shopify the first time. */
    client?: AdminGraphqlClient | null;
    properties?: Record<string, unknown>;
  } = {},
): Promise<TicketPart[]> {
  const quotation = await currentQuotation(ticket.id, db);
  const lines = quotation
    ? await db.quotationLineItem.findMany({
        where: { quotationId: quotation.id, shopifyVariantId: { not: null } },
      })
    : [];
  const services = await db.repairService.findMany({
    where: {
      shopId: ticket.shopId,
      shopifyVariantId: { in: lines.map((line) => line.shopifyVariantId!) },
    },
    include: { components: { include: { part: { include: { variants: true } } } } },
  });
  const byVariant = new Map(services.map((s) => [s.shopifyVariantId, s]));
  const planned = lines.flatMap((line) => {
    const service = byVariant.get(line.shopifyVariantId!);
    return service ? [{ service, quantity: line.quantity }] : [];
  });

  const props = properties ?? (await propertiesFor(ticket, db, client ?? null));
  return inTransaction(db, async (tx) => {
    await tx.ticketPart.deleteMany({
      where: { repairTicketId: ticket.id, consumedAt: null, repairServiceId: { not: null } },
    });
    const created: TicketPart[] = [];
    for (const { service, quantity } of planned) {
      for (const component of service.components) {
        const match = matchComponent(component, props);
        created.push(
          await createTicketPart(
            {
              repairTicketId: ticket.id,
              partId: component.partId,
              partVariantId: match.variant?.id ?? null,
              repairServiceId: service.id,
              quantity: component.quantity.mul(quantity),
            },
            tx,
          ),
        );
      }
    }
    return created;
  });
}

async function propertiesFor(
  ticket: Pick<RepairTicket, "itemId" | "shopId">,
  db: Db,
  client: AdminGraphqlClient | null,
): Promise<Record<string, unknown>> {
  if (!ticket.itemId) return {};
  const item = await db.item.findUnique({ where: { id: ticket.itemId } });
  if (!item) return {};
  if (!client) return (item.properties ?? {}) as Record<string, unknown>;
  const shop: Pick<Shop, "shopifyDomain" | "settings"> = await db.shop.findUniqueOrThrow({
    where: { id: ticket.shopId },
  });
  return itemProperties(shop, client, item, { db });
}

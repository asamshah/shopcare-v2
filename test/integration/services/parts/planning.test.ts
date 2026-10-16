/**
 * Port of Rails test/services/parts/planning_test.rb: Matcher and Planner.
 * (The Consumer half, used when a ticket is completed, belongs with
 * changeTicketStatus in w2-backend.)
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Shop } from "@prisma/client";
import prisma from "../../../../app/db.server";
import { variantMatches } from "../../../../app/models/part-variant.server";
import { recalculateSubtotal } from "../../../../app/models/quotation.server";
import { matchComponent } from "../../../../app/services/parts/matcher.server";
import { planTicketParts } from "../../../../app/services/parts/planner.server";
import {
  buildWorkshop,
  createItemFor,
  createLineItem,
  createQuotationFor,
  createRepairTicketFor,
  createShop,
} from "../../../support/factories";

let shop: Shop;
let workshop: Awaited<ReturnType<typeof buildWorkshop>>;
let ticketId: number;
const properties = { size: "uk 8", sole_model: "Commando", fetched_at: "x" };

beforeEach(async () => {
  shop = await createShop({ settings: { parts: { labour_rate: "40" } } });
  workshop = await buildWorkshop(shop);
  const item = await createItemFor(shop, { productTitle: "Aria Boot", variantId: "100", properties });
  const ticket = await createRepairTicketFor(shop, { productTitle: "Aria Boot", itemId: item.id });
  ticketId = ticket.id;
  const quote = await createQuotationFor(ticket.id);
  await createLineItem(quote.id, { kind: "repair", title: "Resole", quantity: 1, unitPrice: 60, shopifyVariantId: "900" });
  await recalculateSubtotal(quote.id);
});

const soleComponent = () =>
  prisma.serviceComponent.findFirstOrThrow({
    where: { partId: workshop.sole.id },
    include: { part: { include: { variants: true } } },
  });
const soleVariant = async (model: string, size: string) =>
  (await prisma.partVariant.findMany({ where: { partId: workshop.sole.id } })).find(
    (v) => variantMatches(v, "model", model) && variantMatches(v, "size", size),
  )!;

describe("Matcher", () => {
  it("matches the variant from the item's size and model", async () => {
    const match = matchComponent(await soleComponent(), properties);
    expect(match.variant?.id).toBe((await soleVariant("Commando", "UK 8")).id);
  });

  it("fixed and staff-choice rules", async () => {
    const component = await soleComponent();
    await prisma.serviceComponent.update({ where: { id: component.id }, data: { match: { model: "fixed:Gumlite", size: "any" } } });
    const match = matchComponent(await soleComponent(), properties);
    expect(match.variant).toBeNull();
    expect(match.candidates.map((v) => v.id)).toEqual([
      (await soleVariant("Gumlite", "UK 7")).id,
      (await soleVariant("Gumlite", "UK 8")).id,
    ]);
  });
});

describe("Planner", () => {
  it("plans the recipe for the quote, and re-planning keeps hand-added parts", async () => {
    const planned = await planTicketParts({ shopId: shop.id, ticketId });
    expect(planned.map((tp) => [tp.part.name, tp.quantity.toNumber()])).toEqual([
      ["Commando sole", 1],
      ["Adhesive", 30],
    ]);
    expect(planned.every((tp) => tp.partVariantId !== null)).toBe(true);

    const glueVariant = await prisma.partVariant.findFirstOrThrow({ where: { partId: workshop.glue.id } });
    await prisma.ticketPart.create({
      data: { repairTicketId: ticketId, partId: workshop.glue.id, partVariantId: glueVariant.id, quantity: 5 },
    });
    await planTicketParts({ shopId: shop.id, ticketId });
    expect(await prisma.ticketPart.count({ where: { repairTicketId: ticketId } })).toBe(3);
  });

  it("without known properties the variant is left for staff to choose", async () => {
    const planned = await planTicketParts({ shopId: shop.id, ticketId }, { properties: { fetched_at: "x" } });
    expect(planned.find((tp) => tp.partId === workshop.sole.id)?.partVariantId).toBeNull();
  });

  it("only plans this shop's tickets", async () => {
    const other = await createShop();
    await expect(planTicketParts({ shopId: other.id, ticketId })).rejects.toThrow();
  });
});

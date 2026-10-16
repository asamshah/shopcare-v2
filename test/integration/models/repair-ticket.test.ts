// Port of Rails test/models/repair_ticket_test.rb.
import type { RepairTicket, Shop } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
import {
  ACTIVITIES_ORDER,
  currentQuotation,
  REPAIR_TICKET_STATUSES,
  repairTicketSearchWhere,
  updateRepairTicket,
  validateRepairTicket,
} from "../../../app/models/repair-ticket.server";
import {
  createQuotationFor,
  createRepairTicketFor,
  createShop,
  createTicketActivityFor,
} from "../../support/factories";

const ago = (ms: number) => new Date(Date.now() - ms);

describe("RepairTicket", () => {
  let shop: Shop;
  let ticket: RepairTicket;

  const search = async (term: string) =>
    prisma.repairTicket.findMany({ where: await repairTicketSearchWhere(term), orderBy: { id: "asc" } });

  beforeEach(async () => {
    shop = await createShop({ shopifyDomain: "rt-test.myshopify.com" });
    ticket = await createRepairTicketFor(shop, { customerEmail: "c@example.com", productTitle: "Boot" });
  });

  it("defaults to the 'new' status", () => {
    expect(ticket.status).toBe("new");
  });

  it("exposes the full status pipeline", () => {
    expect(REPAIR_TICKET_STATUSES).toEqual([
      "new",
      "assessing",
      "quoted",
      "quote_declined",
      "awaiting_item",
      "received",
      "in_repair",
      "ready",
      "completed",
      "cancelled",
      "rejected",
    ]);
  });

  it("currentQuotation returns the most recent quotation", async () => {
    expect(await currentQuotation(ticket.id)).toBeNull();

    await createQuotationFor(ticket.id, { status: "cancelled", currency: "GBP", createdAt: ago(2 * 86_400_000) });
    const latest = await createQuotationFor(ticket.id, { status: "draft", currency: "GBP", createdAt: ago(3_600_000) });

    expect((await currentQuotation(ticket.id))?.id).toBe(latest.id);
  });

  it("search matches across fields and treats LIKE wildcards literally", async () => {
    await updateRepairTicket(ticket.id, { customerName: "Sarah Johnson" });
    const other = await createRepairTicketFor(shop, { customerEmail: "x@example.com", productTitle: "100% Wool Boot" });

    expect((await search("sarah")).map((t) => t.id)).toContain(ticket.id);
    expect((await search("100%")).map((t) => t.id)).toEqual([other.id]);
    expect(await search("%zzz%")).toEqual([]);
  });

  it("rejects a malformed email", () => {
    expect(validateRepairTicket({ ...ticket, customerEmail: "not-an-email" }).isEmpty).toBe(false);
  });

  it("activities are returned newest first", async () => {
    await createTicketActivityFor(ticket.id, { body: "first", createdAt: ago(2 * 3_600_000) });
    const newest = await createTicketActivityFor(ticket.id, { body: "second", createdAt: ago(60_000) });

    const [first] = await prisma.ticketActivity.findMany({
      where: { repairTicketId: ticket.id },
      orderBy: ACTIVITIES_ORDER,
    });
    expect(first.id).toBe(newest.id);
  });
});

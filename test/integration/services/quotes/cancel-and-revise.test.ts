/** Port of Rails test/services/repairs/quote_canceller_test.rb, plus reviseQuote (admin_quotes_test). */
import type { RepairTicket, Shop } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../../../app/db.server";
import { findByDecisionToken, issueDecisionToken } from "../../../../app/models/quotation.server";
import { cancelOpenQuotesForTicket } from "../../../../app/services/quotes/cancel.server";
import { declineQuote } from "../../../../app/services/quotes/decision.server";
import { reviseQuote } from "../../../../app/services/quotes/revise.server";
import { createQuotationFor, createRepairTicketFor, createShop } from "../../../support/factories";
import { FakeDraftOrders } from "../../../support/fake-draft-orders";
import { dbNotifyDeps, quoteShop, sentQuote } from "../../../support/quotes";

describe("cancelOpenQuotesForTicket", () => {
  let shop: Shop;
  let ticket: RepairTicket;
  let api: FakeDraftOrders;
  const cancel = () => cancelOpenQuotesForTicket({ shopId: shop.id, ticketId: ticket.id, actor: "staff", client: api.client });

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    shop = await createShop({ shopifyDomain: "qc-test.myshopify.com" });
    ticket = await createRepairTicketFor(shop, { productTitle: "Boot", status: "cancelled" });
    api = new FakeDraftOrders();
  });

  it("cancels a sent quote and deletes its draft order", async () => {
    const quotation = await createQuotationFor(ticket.id, { status: "sent", shopifyDraftOrderId: "999" });
    const result = await cancel();
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } })).status).toBe("cancelled");
    expect(result.ok && result.note).toMatch(/draft order deleted/);
    expect(api.kinds()).toEqual(["delete"]);
    expect(
      await prisma.ticketActivity.count({ where: { repairTicketId: ticket.id, activityType: "system", body: result.ok ? result.note! : "" } }),
    ).toBe(1);
  });

  it("still cancels the quote if Shopify refuses, and tells staff", async () => {
    const quotation = await createQuotationFor(ticket.id, { status: "sent", shopifyDraftOrderId: "999" });
    api.failDelete = true;
    const result = await cancel();
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } })).status).toBe("cancelled");
    expect(result.ok && result.note).toMatch(/Couldn't delete the Shopify draft order/);
  });

  it("cancels a sent quote without a draft order, so its link stops working", async () => {
    const quotation = await createQuotationFor(ticket.id, { status: "sent" });
    const token = await issueDecisionToken(quotation.id, new Date(Date.now() + 7 * 86_400_000));
    await cancel();
    expect(api.calls).toEqual([]);
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } })).status).toBe("cancelled");
    expect(await findByDecisionToken(shop.id, token)).toBeNull();
  });

  it("leaves a paid quote alone and skips Shopify for an unsent draft", async () => {
    await createQuotationFor(ticket.id, { status: "paid", shopifyDraftOrderId: "1" });
    expect(await cancel()).toEqual({ ok: true, cancelled: [], note: null });
    const draft = await createQuotationFor(ticket.id, { status: "draft" });
    expect(await cancel()).toEqual({ ok: true, cancelled: [draft.id], note: "Quote cancelled with the ticket." });
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("cancelled");
    expect(api.calls).toEqual([]);
  });
});

describe("reviseQuote", () => {
  let shop: Shop;
  let ticket: RepairTicket;
  let api: FakeDraftOrders;

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dbNotifyDeps();
    shop = await quoteShop("rq-test.myshopify.com");
    ticket = await createRepairTicketFor(shop, { productTitle: "Boot", status: "assessing" });
    api = new FakeDraftOrders();
  });

  it("revising a sent quote cancels it and deletes its draft order, so the old invoice can't be paid", async () => {
    const quotation = await sentQuote(shop, ticket.id, api);
    const result = await reviseQuote({ shopId: shop.id, quotationId: quotation.id, actor: "staff", client: api.client });
    expect(result.ok).toBe(true);
    const old = await prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect([old.status, old.shopifyDraftOrderId]).toEqual(["cancelled", null]);
    const revision = await prisma.quotation.findUniqueOrThrow({
      where: { id: result.ok ? result.newQuotationId : 0 },
      include: { lineItems: true },
    });
    expect([revision.status, revision.revisedFromId, revision.lineItems.length]).toEqual(["draft", quotation.id, 1]);
    expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe("assessing");
    const note = await prisma.ticketActivity.findFirstOrThrow({ where: { repairTicketId: ticket.id, activityType: "note" } });
    expect(note.body).toBe("Quote revised: a new draft replaces the sent quote. Shopify draft order deleted, so its invoice can't be paid.");
  });

  it("a declined quote can be revised; a draft can't", async () => {
    const quotation = await sentQuote(shop, ticket.id, api);
    await declineQuote({ shopId: shop.id, quotationId: quotation.id, by: "customer", reason: "Pricey", client: api.client });
    const result = await reviseQuote({ shopId: shop.id, quotationId: quotation.id, actor: "staff", client: api.client });
    expect(result.ok).toBe(true);
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } })).status).toBe("declined");
    const draft = result.ok ? result.newQuotationId : 0;
    expect(await reviseQuote({ shopId: shop.id, quotationId: draft, actor: "staff", client: api.client })).toEqual({
      ok: false,
      error: "This quote can't be revised.",
    });
  });
});

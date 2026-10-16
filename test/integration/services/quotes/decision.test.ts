/** Port of Rails test/services/repairs/quote_decision_test.rb (+ ExpireQuotesJob). */
import type { Quotation, RepairTicket, Shop } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../../../app/db.server";
import { expireOverdueQuotes } from "../../../../app/jobs/expire-quotes.server";
import { validUntil } from "../../../../app/models/quotation.server";
import { declineQuote, expireQuote } from "../../../../app/services/quotes/decision.server";
import { createRepairTicketFor } from "../../../support/factories";
import { FakeDraftOrders } from "../../../support/fake-draft-orders";
import { captureEnqueue, dbNotifyDeps, quoteShop, sentQuote } from "../../../support/quotes";

describe("declineQuote / expireQuote", () => {
  let shop: Shop;
  let ticket: RepairTicket;
  let api: FakeDraftOrders;
  let quotation: Quotation;
  let outbound: ReturnType<typeof captureEnqueue>;

  const decline = (reason?: string) =>
    declineQuote({ shopId: shop.id, quotationId: quotation.id, reason, by: "customer", client: api.client, enqueue: outbound.enqueue });
  const expire = () =>
    expireQuote({ shopId: shop.id, quotationId: quotation.id, client: api.client, enqueue: outbound.enqueue });
  const reload = () => prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
  const latestActivity = async () =>
    (await prisma.ticketActivity.findFirstOrThrow({ where: { repairTicketId: ticket.id }, orderBy: { id: "desc" } })).body;
  const delivery = (event: string) =>
    prisma.notificationDelivery.findFirstOrThrow({ where: { shopId: shop.id, event, channel: "flow" } });
  const overdue = () =>
    prisma.quotation.update({ where: { id: quotation.id }, data: { decisionExpiresAt: new Date(Date.now() - 60_000) } });

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dbNotifyDeps();
    shop = await quoteShop("qd-test.myshopify.com", {
      notifications: { flow: true },
      webhook_url: "https://hooks.example/x",
    });
    ticket = await createRepairTicketFor(shop, {
      customerEmail: "c@example.com",
      customerName: "Cara",
      productTitle: "Boot",
      status: "assessing",
    });
    api = new FakeDraftOrders();
    outbound = captureEnqueue();
    quotation = await sentQuote(shop, ticket.id, api);
  });

  it("declining records the reason, deletes the draft order and alerts staff", async () => {
    expect(await decline("  Too expensive  ")).toEqual({ ok: true });
    expect(api.calls.at(-1)).toEqual(["delete", { input: { id: "gid://shopify/DraftOrder/999" } }]);
    const q = await reload();
    expect([q.status, q.decisionReason, q.decidedBy, q.shopifyDraftOrderId, q.shopifyDraftOrderUrl]).toEqual([
      "declined", "Too expensive", "customer", null, null,
    ]);
    expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe("quote_declined");
    expect(await latestActivity()).toBe(
      "The customer declined the quote. Reason: Too expensive Shopify draft order deleted, so its invoice can't be paid.",
    );
    const data = ((await delivery("quote_declined")).payload as { data: Record<string, unknown> }).data;
    expect([data.reason, data.customerName, data.customerEmail, data.quoteTotal]).toEqual([
      "Too expensive", "Cara", "c@example.com", "£24.00",
    ]);
    expect(outbound.jobs.map((j) => j.payload.event)).toEqual(["quote_declined"]);
    expect(outbound.jobs[0].payload.detail).toBe("Too expensive");
  });

  it("a declined quote can't be declined again", async () => {
    await decline();
    expect(await decline()).toEqual({ ok: false, error: "This quote has already been declined." });
    expect(api.kinds().filter((k) => k === "delete")).toHaveLength(1);
  });

  it("concurrent declines record one decision", async () => {
    const results = await Promise.all([decline("a"), decline("b")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.ticketActivity.count({ where: { repairTicketId: ticket.id, activityType: "quote_decision" } })).toBe(1);
  });

  it("if Shopify won't delete the draft order, the decline stands and staff are told", async () => {
    api.failDelete = true;
    expect((await decline()).ok).toBe(true);
    const q = await reload();
    expect([q.status, q.shopifyDraftOrderId]).toEqual(["declined", "999"]);
    expect(await latestActivity()).toMatch("Couldn't delete the Shopify draft order (Not found)");
  });

  it("declining after the deadline finds the quote expired", async () => {
    await overdue();
    expect(await decline("Too late")).toEqual({ ok: false, error: "This quote has expired." });
    const q = await reload();
    expect([q.status, q.decidedBy, q.decisionReason]).toEqual(["expired", "system", null]);
  });

  it("expiry deletes the draft order and alerts staff", async () => {
    await overdue();
    expect((await expire()).ok).toBe(true);
    expect(api.kinds().at(-1)).toBe("delete");
    expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe("quote_declined");
    expect(await latestActivity()).toMatch(/^Quote expired: not paid by .* Shopify draft order deleted/);
    const data = ((await delivery("quote_expired")).payload as { data: Record<string, unknown> }).data;
    expect(data.validUntil).toBe(validUntil(await reload()));
    expect(await prisma.notificationDelivery.count({ where: { event: "quote_declined" } })).toBe(0);
    expect(outbound.jobs.at(-1)?.payload.detail).toBe("expired");
  });

  it("expire only touches a quote past its deadline", async () => {
    expect((await expire()).ok).toBe(false);
    expect((await reload()).status).toBe("sent");
  });

  it("the daily job expires overdue quotes", async () => {
    await prisma.quotation.update({ where: { id: quotation.id }, data: { decisionExpiresAt: new Date(Date.now() - 3_600_000) } });
    const otherTicket = await createRepairTicketFor(shop, { customerEmail: "d@example.com", productTitle: "Shoe" });
    const other = await sentQuote(shop, otherTicket.id, api);

    const result = await expireOverdueQuotes({ client: api.client, enqueue: outbound.enqueue });

    expect(result).toEqual({ expired: 1, failed: [] });
    expect([(await reload()).status, (await prisma.quotation.findUniqueOrThrow({ where: { id: other.id } })).status]).toEqual([
      "expired",
      "sent",
    ]);
  });
});

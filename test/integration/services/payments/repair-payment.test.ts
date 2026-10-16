/** Port of Rails test/services/repairs/payment_processor_test.rb. */
import type { Quotation, RepairTicket, Shop } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../../../app/db.server";
import { claimsCount, createCover, warrantyCoverFor } from "../../../../app/models/cover.server";
import { applyCover, recalculateSubtotal } from "../../../../app/models/quotation.server";
import {
  processRepairPayment,
  type PaidOrderBody,
} from "../../../../app/services/payments/repair-payment.server";
import {
  createItemFor,
  createLineItem,
  createQuotationFor,
  createRepairTicketFor,
  createShop,
  createWarrantyPolicyFor,
} from "../../../support/factories";
import { FakeDraftOrders } from "../../../support/fake-draft-orders";
import { captureEnqueue, dbNotifyDeps } from "../../../support/quotes";

describe("processRepairPayment", () => {
  let shop: Shop;
  let ticket: RepairTicket;
  let quotation: Quotation;
  let api: FakeDraftOrders;
  let outbound: ReturnType<typeof captureEnqueue>;

  const paidOrder = (overrides: Partial<PaidOrderBody> = {}): PaidOrderBody => ({
    id: 555,
    name: "#1042",
    total_price: "24.00",
    currency: "GBP",
    tags: "repair",
    note_attributes: [{ name: "repair_quotation_id", value: String(quotation.id) }],
    ...overrides,
  });
  const run = (order = paidOrder(), s = shop) =>
    processRepairPayment(s, order, { client: api.client, enqueue: outbound.enqueue });
  const reloadTicket = () => prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } });
  const reloadQuote = () => prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } });

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dbNotifyDeps();
    shop = await createShop({ shopifyDomain: "pp-test.myshopify.com", settings: { webhook_url: "https://hooks.example/x" } });
    ticket = await createRepairTicketFor(shop, { customerEmail: "c@example.com", productTitle: "Boot", status: "quoted" });
    quotation = await createQuotationFor(ticket.id, { status: "sent", sentAt: new Date(Date.now() - 3_600_000) });
    await createLineItem(quotation.id, { kind: "repair", title: "Sole replacement", unitPrice: 24 });
    await recalculateSubtotal(quotation.id);
    api = new FakeDraftOrders();
    outbound = captureEnqueue();
  });

  it("paying the invoice accepts and pays the quote in one step, asks for the item and alerts staff", async () => {
    shop = await prisma.shop.update({ where: { id: shop.id }, data: { settings: { notifications: { flow: true }, webhook_url: "https://hooks.example/x" } } });
    expect(await run()).toBe("ok");
    const q = await reloadQuote();
    expect([q.status, q.shopifyOrderId, q.decidedBy]).toEqual(["paid", "555", "customer"]);
    expect(q.paidAt).not.toBeNull();
    expect(q.decidedAt).not.toBeNull();
    expect((await reloadTicket()).status).toBe("awaiting_item");
    const payment = await prisma.ticketActivity.findFirstOrThrow({ where: { repairTicketId: ticket.id, activityType: "payment" } });
    expect(payment.body).toBe(
      "The customer paid the invoice, accepting the quote (order #1042, 24.00 GBP). Waiting for the customer to send the item.",
    );
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({ where: { event: "quote_paid", channel: "flow" } });
    const data = (delivery.payload as { data: Record<string, unknown> }).data;
    expect([data.orderName, data.quoteTotal, data.ticketId]).toEqual(["#1042", "£24.00", ticket.id]);
    expect(outbound.jobs.map((j) => j.payload.event)).toEqual(["payment"]);
    expect(await prisma.notificationDelivery.count({ where: { event: "repair_status_changed" } })).toBeGreaterThan(0);
  });

  it("paying counts the cover's claim once", async () => {
    const item = await createItemFor(shop, { productTitle: "Boot" });
    const policy = await createWarrantyPolicyFor(shop, { name: "W", months: 12, outcome: "discount", discountPercent: 25 });
    const cover = await createCover(warrantyCoverFor(item, policy));
    await applyCover(quotation.id, cover);
    await run();
    await run();
    expect(claimsCount(await prisma.cover.findUniqueOrThrow({ where: { id: cover.id } }))).toBe(1);
  });

  it("concurrent deliveries apply the payment once", async () => {
    const results = await Promise.all([run(), run()]);
    expect(results.sort()).toEqual(["already_paid", "ok"]);
    expect(await prisma.ticketActivity.count({ where: { repairTicketId: ticket.id, activityType: "payment" } })).toBe(1);
  });

  it("a payment for a cancelled ticket is flagged for staff, not restarted", async () => {
    await prisma.repairTicket.update({ where: { id: ticket.id }, data: { status: "cancelled" } });
    await prisma.quotation.update({ where: { id: quotation.id }, data: { status: "cancelled" } });
    expect(await run()).toBe("ok");
    expect((await reloadTicket()).status).toBe("cancelled");
    expect((await reloadQuote()).status).toBe("paid");
    const payment = await prisma.ticketActivity.findFirstOrThrow({ where: { repairTicketId: ticket.id, activityType: "payment" } });
    expect(payment.body).toMatch(/ticket is cancelled/);
    expect(await prisma.notificationDelivery.count({ where: { event: "quote_paid" } })).toBe(0);
  });

  it("a payment racing a decline or expiry still counts: the customer paid, so they accepted", async () => {
    await prisma.quotation.update({ where: { id: quotation.id }, data: { status: "declined" } });
    await prisma.repairTicket.update({ where: { id: ticket.id }, data: { status: "quote_declined" } });
    expect(await run()).toBe("ok");
    expect((await reloadQuote()).status).toBe("paid");
    expect((await reloadTicket()).status).toBe("awaiting_item");
  });

  it("paying for an item the workshop already has starts the repair", async () => {
    await prisma.repairTicket.update({ where: { id: ticket.id }, data: { itemReceivedAt: new Date() } });
    expect(await run()).toBe("ok");
    expect((await reloadTicket()).status).toBe("in_repair");
    const payment = await prisma.ticketActivity.findFirstOrThrow({ where: { repairTicketId: ticket.id, activityType: "payment" } });
    expect(payment.body).toMatch(/Repair started\.$/);
  });

  it("won't apply a payment to a quote that was never sent", async () => {
    await prisma.quotation.update({ where: { id: quotation.id }, data: { status: "draft" } });
    expect(await run()).toBe("not_sent");
    expect([(await reloadQuote()).status, (await reloadTicket()).status]).toEqual(["draft", "quoted"]);
  });

  it("ignores orders that aren't tagged as repairs", async () => {
    expect(await run(paidOrder({ tags: "subscription" }))).toBe("not_repair");
    expect([(await reloadQuote()).status, (await reloadTicket()).status]).toEqual(["sent", "quoted"]);
  });

  it("is idempotent for an already-paid quotation", async () => {
    await prisma.quotation.update({ where: { id: quotation.id }, data: { status: "paid", paidAt: new Date() } });
    expect(await run()).toBe("already_paid");
  });

  it("returns no_quotation when the link is missing; another shop's quote isn't found", async () => {
    expect(await run(paidOrder({ note_attributes: [{ name: "repair_quotation_id", value: "0" }] }))).toBe("no_quotation");
    const other = await createShop({ shopifyDomain: "pp-other.myshopify.com" });
    expect(await run(paidOrder(), other)).toBe("no_quotation");
  });

  it("falls back to the source draft order id", async () => {
    await prisma.quotation.update({ where: { id: quotation.id }, data: { shopifyDraftOrderId: "321" } });
    expect(await run(paidOrder({ note_attributes: [], draft_order_id: 321 }))).toBe("ok");
  });

  it("syncs the customer status metafield to paid", async () => {
    await prisma.repairTicket.update({ where: { id: ticket.id }, data: { shopifyCustomerId: "777", productId: "11", variantId: "22" } });
    expect(await run()).toBe("ok");
    const [, variables] = api.calls.find(([kind]) => kind === "metafield")!;
    const metafield = (variables.metafields as { ownerId: string; value: string }[])[0];
    expect(metafield.ownerId).toBe("gid://shopify/Customer/777");
    expect(JSON.parse(metafield.value)).toEqual({ "11_22": "paid" });
  });
});

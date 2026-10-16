/**
 * "Mark returned": fulfils the repair order with tracking and notifyCustomer
 * so Shopify sends its Shipping confirmation, then completes the ticket.
 */
import type { RepairTicket, Shop } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../../../app/db.server";
import { returnRepairedItem } from "../../../../app/services/repairs/return-item.server";
import { createQuotationFor, createRepairTicketFor, createShop } from "../../../support/factories";
import { FakeGraphql } from "../../../support/fake-graphql";
import { captureEnqueue, dbNotifyDeps } from "../../../support/quotes";

const fulfillmentOrders = (...actions: string[][]) => ({
  order: {
    id: "gid://shopify/Order/5001",
    name: "#5001",
    fulfillmentOrders: {
      nodes: actions.map((list, i) => ({
        id: `gid://shopify/FulfillmentOrder/${70 + i}`,
        status: list.length ? "OPEN" : "CLOSED",
        supportedActions: list.map((action) => ({ action })),
      })),
    },
  },
});

describe("returnRepairedItem", () => {
  let shop: Shop;
  let ticket: RepairTicket;
  let graphql: FakeGraphql;
  let outbound: ReturnType<typeof captureEnqueue>;
  const ret = (tracking = { company: "Royal Mail", number: "RM123GB", url: "" }) =>
    returnRepairedItem({ shopId: shop.id, ticketId: ticket.id, actor: "staff", tracking, client: graphql, enqueue: outbound.enqueue });

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dbNotifyDeps();
    shop = await createShop({ shopifyDomain: "ret-test.myshopify.com" });
    ticket = await createRepairTicketFor(shop, { customerEmail: "c@example.com", productTitle: "Boot", status: "ready" });
    await createQuotationFor(ticket.id, { status: "paid", shopifyOrderId: "5001", paidAt: new Date() });
    graphql = new FakeGraphql({
      "fulfillmentOrders(": fulfillmentOrders(["CREATE_FULFILLMENT", "HOLD"], []),
      "fulfillmentCreate(": {
        fulfillmentCreate: { fulfillment: { id: "gid://shopify/Fulfillment/88", status: "SUCCESS" }, userErrors: [] },
      },
    });
    outbound = captureEnqueue();
  });

  it("fulfils the open fulfillment orders with tracking, notifying the customer, and completes the ticket", async () => {
    const result = await ret();
    expect(result).toEqual({ ok: true, message: "Marked as returned. Shopify emailed the customer the tracking details." });
    const create = graphql.calls.find((c) => c.query.includes("fulfillmentCreate("))!;
    expect(create.variables).toEqual({
      fulfillment: {
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "gid://shopify/FulfillmentOrder/70" }],
        notifyCustomer: true,
        trackingInfo: { company: "Royal Mail", number: "RM123GB" },
      },
    });
    expect(graphql.calls[0].variables).toEqual({ id: "gid://shopify/Order/5001" });
    expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe("completed");
    const bodies = (await prisma.ticketActivity.findMany({ where: { repairTicketId: ticket.id }, orderBy: { id: "asc" } })).map(
      (a) => a.body,
    );
    expect(bodies).toEqual([
      "Item posted back (Royal Mail RM123GB). Order #5001 fulfilled: Shopify emailed the customer its shipping confirmation.",
      "Status changed from ready to completed.",
    ]);
  });

  it("needs a tracking number or link, a valid link, and a returnable status", async () => {
    expect(await ret({ company: "Royal Mail", number: " ", url: "" })).toMatchObject({ ok: false, error: expect.stringMatching(/tracking number/) });
    expect(await ret({ company: "", number: "", url: "ftp://x" })).toMatchObject({ ok: false, error: expect.stringMatching(/full web address/) });
    await prisma.repairTicket.update({ where: { id: ticket.id }, data: { status: "awaiting_item" } });
    expect(await ret()).toEqual({ ok: false, error: "A awaiting item ticket can't be marked as returned." });
    expect(graphql.calls).toEqual([]);
  });

  it("refuses a repair without a paid Shopify order", async () => {
    await prisma.quotation.updateMany({ where: { repairTicketId: ticket.id }, data: { status: "sent", shopifyOrderId: null } });
    expect(await ret()).toMatchObject({ ok: false, error: expect.stringMatching(/no paid Shopify order/) });
  });

  it("an order already fulfilled in Shopify is reported, and the ticket keeps its status", async () => {
    graphql = new FakeGraphql({ "fulfillmentOrders(": fulfillmentOrders([]) });
    expect(await ret()).toEqual({
      ok: false,
      error: "Order #5001 has nothing left to fulfil in Shopify. Fulfil it in Shopify, or set the status to Completed.",
    });
    expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe("ready");
  });

  it("a Shopify user error leaves the ticket as it was", async () => {
    graphql = new FakeGraphql({
      "fulfillmentOrders(": fulfillmentOrders(["CREATE_FULFILLMENT"]),
      "fulfillmentCreate(": { fulfillmentCreate: { fulfillment: null, userErrors: [{ field: null, message: "Access denied" }] } },
    });
    const result = await ret();
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/^Shopify couldn't fulfil the order: .*Access denied/);
    expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe("ready");
  });
});

/** changeTicketStatus: Rails TicketsController#update_status + RepairTicket's status notification. */
import type { RepairTicket, Shop } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../../../app/db.server";
import { changeTicketStatus } from "../../../../app/services/repairs/ticket-status.server";
import {
  buildWorkshop,
  createQuotationFor,
  createLineItem,
  createRepairTicketFor,
  createShop,
} from "../../../support/factories";
import { FakeDraftOrders } from "../../../support/fake-draft-orders";
import { captureEnqueue, dbNotifyDeps } from "../../../support/quotes";

describe("changeTicketStatus", () => {
  let shop: Shop;
  let ticket: RepairTicket;
  let api: FakeDraftOrders;
  let outbound: ReturnType<typeof captureEnqueue>;
  let notifications: ReturnType<typeof dbNotifyDeps>;
  const change = (to: string, note?: string) =>
    changeTicketStatus({ shopId: shop.id, ticketId: ticket.id, to, actor: "staff", note, client: api.client, enqueue: outbound.enqueue });

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    notifications = dbNotifyDeps();
    shop = await createShop({ shopifyDomain: "ts-test.myshopify.com", settings: { webhook_url: "https://hooks.example/x", notifications: { flow: true } } });
    ticket = await createRepairTicketFor(shop, { customerEmail: "c@example.com", productTitle: "Boot", status: "in_repair" });
    api = new FakeDraftOrders();
    outbound = captureEnqueue();
  });

  it("logs the change, sends the outbound webhook and fires the Flow trigger", async () => {
    expect(await change("ready", "Polished too.")).toEqual({ ok: true, changed: true, message: "Status updated to ready." });
    expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe("ready");
    const activity = await prisma.ticketActivity.findFirstOrThrow({ where: { repairTicketId: ticket.id } });
    expect([activity.activityType, activity.author, activity.body]).toEqual([
      "status_change", "staff", "Status changed from in_repair to ready. Polished too.",
    ]);
    expect(outbound.jobs.map((j) => [j.payload.event, j.payload.detail])).toEqual([["status_change", "ready"]]);
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({ where: { event: "repair_status_changed" } });
    expect([delivery.channel, delivery.idempotencyKey]).toEqual(["flow", `repair_status_changed:ticket_${ticket.id}:ready`]);
    expect(notifications.enqueued).toEqual([String(delivery.id)]);
  });

  it("rejects an unknown status and does nothing for the current one", async () => {
    expect(await change("lost")).toEqual({ ok: false, error: "Unknown status." });
    expect(await change("in_repair")).toEqual({ ok: true, changed: false, message: "" });
    expect(await prisma.ticketActivity.count()).toBe(0);
    expect(outbound.jobs).toEqual([]);
  });

  it("refuses another shop's ticket", async () => {
    const other = await createShop();
    expect(
      await changeTicketStatus({ shopId: other.id, ticketId: ticket.id, to: "ready", actor: "staff", client: api.client }),
    ).toEqual({ ok: false, error: "Ticket not found." });
  });

  it("cancelling cancels the open quote and deletes its draft order", async () => {
    const quotation = await createQuotationFor(ticket.id, { status: "sent", shopifyDraftOrderId: "999" });
    const result = await change("cancelled");
    expect(result.ok && result.message).toMatch(/^Status updated to cancelled\. Quote cancelled with the ticket\. Shopify draft order deleted/);
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } })).status).toBe("cancelled");
  });

  it("completing a repair takes its parts out of stock when the workshop is on", async () => {
    shop = await prisma.shop.update({ where: { id: shop.id }, data: { settings: { parts_enabled: "1" } } });
    const { sole, glue } = await buildWorkshop(shop);
    const quotation = await createQuotationFor(ticket.id, { status: "paid", subtotal: 60 });
    await createLineItem(quotation.id, { kind: "repair", title: "Resole", unitPrice: 60, shopifyVariantId: "900" });
    const glueVariant = await prisma.partVariant.findFirstOrThrow({ where: { partId: glue.id } });
    await prisma.partVariant.update({ where: { id: glueVariant.id }, data: { onHand: 500 } });

    const result = await change("completed");

    expect(result.ok && result.message).toBe(
      "Status updated to completed. 1 part taken from stock. Not taken from stock (no variant chosen): Commando sole.",
    );
    expect(Number((await prisma.partVariant.findUniqueOrThrow({ where: { id: glueVariant.id } })).onHand)).toBe(470);
    const costs = (await prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } })).costs as Record<string, unknown>;
    expect([costs.parts, costs.price, costs.labour_minutes]).toEqual(["12.6", "60.0", 45]);
    expect(sole.id).toBeDefined();

    // Completing again (e.g. reopened and completed) takes nothing twice.
    await prisma.repairTicket.update({ where: { id: ticket.id }, data: { status: "ready" } });
    await change("completed");
    expect(Number((await prisma.partVariant.findUniqueOrThrow({ where: { id: glueVariant.id } })).onHand)).toBe(470);
  });
});

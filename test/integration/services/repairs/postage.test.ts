/**
 * Postage slips: the ticket waits for the customer's item, they're emailed a
 * slip (once), staff can resend it and mark the parcel received.
 */
import type { RepairTicket, Shop } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../../../app/db.server";
import { MemoryStorage } from "../../../../app/lib/storage.server";
import { deliverNotification, setNotificationDeps } from "../../../../app/services/notifications.server";
import { setEmailAdapter } from "../../../../app/services/email.server";
import { processRepairPayment } from "../../../../app/services/payments/repair-payment.server";
import { resendPostageEmail } from "../../../../app/services/repairs/item-postage.server";
import {
  ensurePostageSlip,
  postageSlipAttachments,
  postageSlipKey,
  postageSlipLink,
  verifyPostageSlipLink,
} from "../../../../app/services/repairs/postage-slip.server";
import { changeTicketStatus, markItemReceived } from "../../../../app/services/repairs/ticket-status.server";
import {
  createLineItem,
  createQuotationFor,
  createRepairTicketFor,
  createShop,
  WORKSHOP_SETTINGS,
} from "../../../support/factories";
import { FakeDraftOrders } from "../../../support/fake-draft-orders";
import { captureEnqueue, dbNotifyDeps } from "../../../support/quotes";
import { recalculateSubtotal } from "../../../../app/models/quotation.server";

const domain = "postage-test.myshopify.com";

describe("postage slips", () => {
  let shop: Shop;
  let ticket: RepairTicket;
  let api: FakeDraftOrders;
  let outbound: ReturnType<typeof captureEnqueue>;
  let notifications: ReturnType<typeof dbNotifyDeps>;
  let storage: MemoryStorage;

  const reload = () => prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } });
  const deliveries = (event: string) =>
    prisma.notificationDelivery.findMany({ where: { event }, orderBy: { id: "asc" } });

  async function payQuote(t = ticket) {
    const quotation = await createQuotationFor(t.id, { status: "sent", sentAt: new Date() });
    await createLineItem(quotation.id, { kind: "repair", title: "Sole replacement", unitPrice: 24 });
    await recalculateSubtotal(quotation.id);
    return processRepairPayment(
      shop,
      { id: 555, name: "#1042", tags: "repair", total_price: "24.00", currency: "GBP", note_attributes: [{ name: "repair_quotation_id", value: String(quotation.id) }] },
      { client: api.client, enqueue: outbound.enqueue },
    );
  }

  /** Runs every queued delivery with the production attachment resolver (memory storage). */
  async function deliverQueued() {
    const deps = { ...notifications.deps, attachments: (d: Parameters<typeof postageSlipAttachments>[0]) => postageSlipAttachments(d, { storage }) };
    for (const id of notifications.enqueued.splice(0)) await deliverNotification(id, deps);
  }

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    notifications = dbNotifyDeps();
    storage = new MemoryStorage();
    shop = await createShop({ shopifyDomain: domain, settings: { ...WORKSHOP_SETTINGS } });
    notifications.settings.current = { ...notifications.settings.current, shopId: domain };
    ticket = await createRepairTicketFor(shop, {
      customerEmail: "sarah@example.com",
      customerName: "Sarah Jones",
      shopifyCustomerId: "77",
      productTitle: "Chelsea Boot",
      variantTitle: "UK 7",
      customerAddress: { address1: "12 Bow Lane", city: "London", zip: "EC4M 9EU", country: "United Kingdom" },
      status: "quoted",
    });
    api = new FakeDraftOrders();
    outbound = captureEnqueue();
  });
  afterEach(() => {
    setNotificationDeps(undefined);
    setEmailAdapter(undefined);
  });

  it("a paid quote asks for the item: one email with the slip attached, however often it's triggered", async () => {
    expect(await payQuote()).toBe("ok");
    expect((await reload()).status).toBe("awaiting_item");
    const [requested] = await deliveries("item_requested");
    expect([requested.channel, requested.idempotencyKey]).toEqual(["email", `item_requested:ticket_${ticket.id}:1`]);
    const data = (requested.payload as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      ticketId: ticket.id,
      workshopAddress: ["Acme Repairs", "4 Cobbler's Yard", "Northampton NN1 1AA", "United Kingdom"],
      instructions: "Use a tracked service.",
      sendNumber: 1,
    });
    expect(String(data.downloadUrl)).toMatch(
      new RegExp(`^https://${domain}/apps/repairs/tickets/${ticket.id}/postage-slip\\?expires=\\d+&token=[0-9a-f]{64}$`),
    );

    // Back to awaiting_item later (staff moved it around): no second email.
    await changeTicketStatus({ shopId: shop.id, ticketId: ticket.id, to: "assessing", actor: "staff", client: api.client, enqueue: outbound.enqueue });
    await changeTicketStatus({ shopId: shop.id, ticketId: ticket.id, to: "awaiting_item", actor: "staff", client: api.client, enqueue: outbound.enqueue });
    expect(await deliveries("item_requested")).toHaveLength(1);

    await deliverQueued();
    const sent = notifications.email.sent.filter((m) => m.tags?.email === "send_item");
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe(`Send your Chelsea Boot to us (repair #${ticket.id})`);
    expect(sent[0].attachments).toHaveLength(1);
    expect(sent[0].attachments![0]).toMatchObject({ filename: `repair-${ticket.id}-postage-slip.pdf`, contentType: "application/pdf" });
    expect(Buffer.from(sent[0].attachments![0].content.slice(0, 5)).toString()).toBe("%PDF-");
    // The slip is stored against the ticket.
    expect((await reload()).postageSlipKey).toBe(postageSlipKey(shop.id, ticket.id));
    expect(await storage.get(postageSlipKey(shop.id, ticket.id))).not.toBeNull();
    const activity = await prisma.ticketActivity.findFirst({ where: { repairTicketId: ticket.id, body: { startsWith: "Postage slip emailed" } } });
    expect(activity).not.toBeNull();
  });

  it("guests get the email too", async () => {
    await prisma.repairTicket.update({ where: { id: ticket.id }, data: { shopifyCustomerId: null } });
    await payQuote();
    expect((await deliveries("item_requested")).map((d) => d.channel)).toEqual(["email"]);
  });

  it("without a workshop address nothing is sent and the ticket says why; a resend works once it's added", async () => {
    shop = await prisma.shop.update({ where: { id: shop.id }, data: { settings: {} } });
    await payQuote();
    expect((await reload()).status).toBe("awaiting_item");
    expect(await deliveries("item_requested")).toHaveLength(0);
    const note = await prisma.ticketActivity.findFirstOrThrow({ where: { repairTicketId: ticket.id, body: { startsWith: "Postage slip not sent" } } });
    expect(note.body).toMatch(/Settings → Repairs/);
    expect(await resendPostageEmail(shop, ticket.id)).toEqual({ ok: false, error: expect.stringMatching(/workshop address/) });
    await expect(ensurePostageSlip(shop, ticket.id, { storage })).rejects.toThrow(/workshop address/);

    shop = await prisma.shop.update({ where: { id: shop.id }, data: { settings: { ...WORKSHOP_SETTINGS } } });
    expect(await resendPostageEmail(shop, ticket.id)).toMatchObject({ ok: true });
    expect((await deliveries("item_requested")).map((d) => d.idempotencyKey)).toEqual([`item_requested:ticket_${ticket.id}:1`]);
  });

  it("Resend postage email queues a new email each time", async () => {
    await payQuote();
    expect(await resendPostageEmail(shop, ticket.id)).toEqual({ ok: true, message: "Postage email sent again to sarah@example.com." });
    await resendPostageEmail(shop, ticket.id);
    expect((await deliveries("item_requested")).map((d) => d.idempotencyKey)).toEqual([
      `item_requested:ticket_${ticket.id}:1`,
      `item_requested:ticket_${ticket.id}:2`,
      `item_requested:ticket_${ticket.id}:3`,
    ]);
    await deliverQueued();
    expect(notifications.email.sent.filter((m) => m.tags?.email === "send_item")).toHaveLength(3);
  });

  it("Resend postage email only for a ticket awaiting its item", async () => {
    expect(await resendPostageEmail(shop, ticket.id)).toEqual({ ok: false, error: expect.stringMatching(/awaiting/) });
    const other = await createShop();
    expect(await resendPostageEmail(other, ticket.id)).toEqual({ ok: false, error: "Ticket not found." });
  });

  it("Mark received moves an awaiting ticket to received and tells the customer, once", async () => {
    await payQuote();
    const result = await markItemReceived({ shopId: shop.id, ticketId: ticket.id, actor: "staff", client: api.client, enqueue: outbound.enqueue });
    expect(result).toEqual({ ok: true, message: "Item marked as received. The customer has been told." });
    const t = await reload();
    expect([t.status, t.itemReceivedAt !== null]).toEqual(["received", true]);
    const activity = await prisma.ticketActivity.findFirstOrThrow({ where: { repairTicketId: ticket.id, activityType: "status_change" }, orderBy: { id: "desc" } });
    expect(activity.body).toBe("Status changed from awaiting_item to received.");
    expect((await deliveries("item_received")).map((d) => [d.channel, d.idempotencyKey])).toEqual([["email", `item_received:ticket_${ticket.id}`]]);

    expect(await markItemReceived({ shopId: shop.id, ticketId: ticket.id, actor: "staff" })).toEqual({
      ok: false,
      error: "This item is already marked as received.",
    });
    // Staff carry on: received → in_repair.
    expect(await changeTicketStatus({ shopId: shop.id, ticketId: ticket.id, to: "in_repair", actor: "staff", client: api.client, enqueue: outbound.enqueue })).toMatchObject({ ok: true, changed: true });
    await deliverQueued();
    expect(notifications.email.sent.filter((m) => m.tags?.email === "item_received")).toHaveLength(1);
  });

  it("an item that arrives before it's quoted keeps its status; paying then starts the repair", async () => {
    await prisma.repairTicket.update({ where: { id: ticket.id }, data: { status: "assessing" } });
    expect(await markItemReceived({ shopId: shop.id, ticketId: ticket.id, actor: "staff" })).toMatchObject({ ok: true });
    expect((await reload()).status).toBe("assessing");
    expect(await prisma.ticketActivity.count({ where: { repairTicketId: ticket.id, body: "Item received at the workshop." } })).toBe(1);
    expect(await deliveries("item_received")).toHaveLength(1);

    await prisma.repairTicket.update({ where: { id: ticket.id }, data: { status: "quoted" } });
    await payQuote();
    expect((await reload()).status).toBe("in_repair");
    expect(await deliveries("item_requested")).toHaveLength(0);
  });

  it("choosing Received from the status menu records the arrival too", async () => {
    await payQuote();
    await changeTicketStatus({ shopId: shop.id, ticketId: ticket.id, to: "received", actor: "staff", client: api.client, enqueue: outbound.enqueue });
    expect((await reload()).itemReceivedAt).not.toBeNull();
    expect(await deliveries("item_received")).toHaveLength(1);
  });

  it("won't mark a closed ticket received", async () => {
    await prisma.repairTicket.update({ where: { id: ticket.id }, data: { status: "cancelled" } });
    expect(await markItemReceived({ shopId: shop.id, ticketId: ticket.id, actor: "staff" })).toEqual({ ok: false, error: "This ticket is cancelled." });
  });

  describe("ensurePostageSlip", () => {
    it("reuses the stored slip until something on it changes", async () => {
      const first = await ensurePostageSlip(shop, ticket.id, { storage, now: new Date("2026-10-16T10:00:00Z") });
      expect(first.generated).toBe(true);
      const again = await ensurePostageSlip(shop, ticket.id, { storage, now: new Date("2026-10-20T10:00:00Z") });
      expect(again.generated).toBe(false);
      expect(Buffer.from(again.content).equals(Buffer.from(first.content))).toBe(true);

      shop = await prisma.shop.update({
        where: { id: shop.id },
        data: { settings: { ...WORKSHOP_SETTINGS, workshop_address: { ...WORKSHOP_SETTINGS.workshop_address, line1: "9 New Street" } } },
      });
      expect((await ensurePostageSlip(shop, ticket.id, { storage })).generated).toBe(true);
      shop = await prisma.shop.update({ where: { id: shop.id }, data: { settings: { ...(shop.settings as object), posting_instructions: "Use Royal Mail." } } });
      expect((await ensurePostageSlip(shop, ticket.id, { storage })).generated).toBe(true);
      await prisma.repairTicket.update({ where: { id: ticket.id }, data: { customerAddress: { address1: "1 Other Road" } } });
      expect((await ensurePostageSlip(shop, ticket.id, { storage })).generated).toBe(true);
      expect((await ensurePostageSlip(shop, ticket.id, { storage })).generated).toBe(false);
    });

    it("redraws a slip whose stored file went missing", async () => {
      await ensurePostageSlip(shop, ticket.id, { storage });
      await storage.delete(postageSlipKey(shop.id, ticket.id));
      expect((await ensurePostageSlip(shop, ticket.id, { storage })).generated).toBe(true);
    });
  });

  describe("signed links", () => {
    const now = new Date("2026-10-16T10:00:00Z");
    const params = (url: string) => new URL(url).searchParams;

    it("are valid for their ticket and shop until they expire", () => {
      const link = postageSlipLink(shop, ticket.id, { now });
      expect(verifyPostageSlipLink(domain, ticket.id, params(link), now)).toBe("valid");
      expect(verifyPostageSlipLink(domain, ticket.id, params(link), new Date("2026-11-14T10:00:00Z"))).toBe("valid");
      expect(verifyPostageSlipLink(domain, ticket.id, params(link), new Date("2026-11-16T10:00:01Z"))).toBe("expired");
    });

    it("reject tampering, another ticket or another shop", () => {
      const link = new URL(postageSlipLink(shop, ticket.id, { now }));
      expect(verifyPostageSlipLink(domain, ticket.id + 1, link.searchParams, now)).toBe("invalid");
      expect(verifyPostageSlipLink("other.myshopify.com", ticket.id, link.searchParams, now)).toBe("invalid");
      const later = new URLSearchParams(link.searchParams);
      later.set("expires", String(Number(later.get("expires")) + 86_400));
      expect(verifyPostageSlipLink(domain, ticket.id, later, now)).toBe("invalid");
      const bad = new URLSearchParams(link.searchParams);
      bad.set("token", "0".repeat(64));
      expect(verifyPostageSlipLink(domain, ticket.id, bad, now)).toBe("invalid");
      expect(verifyPostageSlipLink(domain, ticket.id, new URLSearchParams(), now)).toBe("missing");
    });
  });
});

/**
 * Shopify webhooks end to end: HMAC-signed requests through the routes,
 * acked and handed to the `webhook` job (BACKGROUND_DISPATCH=sync, so the job
 * has run when the route returns). Port of Rails test/jobs/shop_webhook_jobs_test.rb
 * and test/services/repairs/customer_redactor_test.rb, plus the v2 GDPR
 * export and redaction completeness.
 */
import type { Shop } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../app/db.server";
import { setWebhookJobDeps } from "../../app/jobs/webhook.server";
import { MemoryStorage, verifySignedUrl } from "../../app/lib/storage.server";
import { moveStock } from "../../app/models/part-variant.server";
import { createCover, warrantyCoverFor } from "../../app/models/cover.server";
import { action as appUninstalled } from "../../app/routes/webhooks.app.uninstalled";
import { action as dataRequest } from "../../app/routes/webhooks.customers.data_request";
import { action as customersRedact } from "../../app/routes/webhooks.customers.redact";
import { action as ordersPaid } from "../../app/routes/webhooks.orders.paid";
import { action as refundsCreate } from "../../app/routes/webhooks.refunds.create";
import { action as shopRedact } from "../../app/routes/webhooks.shop.redact";
import {
  buildWorkshop,
  createItemFor,
  createNotificationDeliveryFor,
  createQuotationFor,
  createRegistrationFor,
  createRepairTicketFor,
  createSession,
  createShop,
  createTicketActivityFor,
  createTicketImageFor,
  createTradeInFor,
  createWarrantyPolicyFor,
} from "../support/factories";
import { FakeDraftOrders } from "../support/fake-draft-orders";
import { dbNotifyDeps } from "../support/quotes";
import { webhookRequest } from "../support/shopify-requests";

type Action = typeof ordersPaid;
const deliver = (route: Action, topic: string, shop: string, payload: unknown) =>
  route({
    request: webhookRequest(`/webhooks/${topic}`, { topic, shop, payload }),
    params: {},
    context: {},
  } as Parameters<Action>[0]);

describe("Shopify webhooks", () => {
  let shop: Shop;
  let storage: MemoryStorage;
  let api: FakeDraftOrders;

  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const notify = dbNotifyDeps();
    storage = new MemoryStorage();
    api = new FakeDraftOrders();
    setWebhookJobDeps({
      client: async () => api.client,
      notifyDeps: notify.deps,
      storage,
      enqueue: async () => {},
    });
    shop = await createShop({ shopifyDomain: "jobs-test.myshopify.com" });
  });
  afterEach(() => {
    setWebhookJobDeps({});
    vi.restoreAllMocks();
  });

  it("rejects a delivery with a bad HMAC", async () => {
    const request = webhookRequest("/webhooks/orders/paid", { topic: "orders/paid", shop: shop.shopifyDomain, payload: { id: 1 } });
    request.headers.set("x-shopify-hmac-sha256", "bm9wZQ==");
    await expect(ordersPaid({ request, params: {}, context: {} } as Parameters<Action>[0])).rejects.toMatchObject({ status: 401 });
  });

  it("orders/paid records items for an ordinary sale, once", async () => {
    const body = {
      id: 1,
      name: "#1",
      tags: "",
      email: "a@example.com",
      processed_at: new Date(Date.now() - 86_400_000).toISOString(),
      customer: { id: 9 },
      line_items: [{ id: 11, product_id: 2, variant_id: 3, title: "Boot", quantity: 1, requires_shipping: true }],
    };
    expect((await deliver(ordersPaid, "orders/paid", shop.shopifyDomain, body)).status).toBe(200);
    await deliver(ordersPaid, "orders/paid", shop.shopifyDomain, body); // duplicate delivery
    expect((await prisma.item.findMany({ where: { shopId: shop.id } })).map((i) => i.orderLineId)).toEqual(["11"]);
  });

  it("orders/paid for a repair invoice pays the quote", async () => {
    const ticket = await createRepairTicketFor(shop, { status: "quoted" });
    const quotation = await createQuotationFor(ticket.id, { status: "sent" });
    await deliver(ordersPaid, "orders/paid", shop.shopifyDomain, {
      id: 77,
      name: "#77",
      tags: "repair",
      total_price: "24.00",
      currency: "GBP",
      note_attributes: [{ name: "repair_quotation_id", value: String(quotation.id) }],
      line_items: [],
    });
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } })).status).toBe("paid");
    expect(await prisma.item.count()).toBe(0);
  });

  it("orders/paid links a product-page trade-in when trade-in is on", async () => {
    shop = await prisma.shop.update({ where: { id: shop.id }, data: { settings: { trade_in_enabled: "1" } } });
    const tradeIn = await createTradeInFor(shop, { status: "pending_purchase", source: "pdp", shopifyCustomerId: "9" });
    await deliver(ordersPaid, "orders/paid", shop.shopifyDomain, {
      id: 900,
      name: "#900",
      tags: "",
      email: "a@example.com",
      customer: { id: 9 },
      line_items: [
        { id: 12, product_id: 2, variant_id: 3, title: "Boot", quantity: 1, properties: [{ name: "_shopcare_trade_in", value: String(tradeIn.id) }] },
      ],
    });
    const linked = await prisma.tradeIn.findUniqueOrThrow({ where: { id: tradeIn.id } });
    expect([linked.status, linked.shopifyOrderId, linked.orderName]).toEqual(["requested", "900", "#900"]);
  });

  it("refunds/create marks the refunded item", async () => {
    const item = await createItemFor(shop, { productTitle: "Boot", orderLineId: "11" });
    await deliver(refundsCreate, "refunds/create", shop.shopifyDomain, {
      id: 1,
      order_id: 5,
      refund_line_items: [{ line_item_id: 11, quantity: 1 }],
    });
    expect((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("refunded");
  });

  it("a webhook for an already-removed shop is a no-op, not an error", async () => {
    for (const [route, topic] of [
      [appUninstalled, "app/uninstalled"],
      [shopRedact, "shop/redact"],
      [customersRedact, "customers/redact"],
      [dataRequest, "customers/data_request"],
      [ordersPaid, "orders/paid"],
      [refundsCreate, "refunds/create"],
    ] as [Action, string][]) {
      expect((await deliver(route, topic, "gone.myshopify.com", { id: 1 })).status).toBe(200);
    }
  });

  it("app/uninstalled marks the shop uninstalled and drops its sessions, keeping its data", async () => {
    await createSession({ shop: shop.shopifyDomain });
    const ticket = await createRepairTicketFor(shop);
    await deliver(appUninstalled, "app/uninstalled", shop.shopifyDomain, {});
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).uninstalledAt).not.toBeNull();
    expect(await prisma.session.count({ where: { shop: shop.shopifyDomain } })).toBe(0);
    expect(await prisma.repairTicket.count({ where: { id: ticket.id } })).toBe(1);
  });

  it("shop/redact removes the shop's data and stored files", async () => {
    const ticket = await createRepairTicketFor(shop, { postageSlipKey: "shops/1/tickets/1/postage-slip.pdf" });
    const image = await createTicketImageFor(ticket.id);
    await storage.put(image.storageKey!, "jpeg");
    await storage.put("shops/1/tickets/1/postage-slip.pdf", "pdf");
    const pending = { name: "webhook", shopDomain: shop.shopifyDomain, payload: { email: "a@example.com" } };
    await prisma.job.create({ data: pending });
    await prisma.job.create({ data: { ...pending, shopDomain: "other.myshopify.com" } });
    await deliver(shopRedact, "shop/redact", shop.shopifyDomain, {});
    expect((await prisma.job.findMany()).map((e) => e.shopDomain)).toEqual(["other.myshopify.com"]);
    expect(await prisma.shop.count({ where: { id: shop.id } })).toBe(0);
    expect(await prisma.repairTicket.count({ where: { id: ticket.id } })).toBe(0);
    expect(await storage.get(image.storageKey!)).toBeNull();
    expect(await storage.get("shops/1/tickets/1/postage-slip.pdf")).toBeNull();
  });

  it("shop/redact removes a shop with items, cover, parts and stock history", async () => {
    const ticket = await createRepairTicketFor(shop);
    const workshop = await buildWorkshop(shop);
    const variant = await prisma.partVariant.findFirstOrThrow({ where: { partId: workshop.sole.id } });
    await moveStock(variant.id, 2, { reason: "received" });
    await prisma.ticketPart.create({
      data: { repairTicketId: ticket.id, partId: workshop.sole.id, partVariantId: variant.id, quantity: 1, consumedAt: new Date() },
    });
    await moveStock(variant.id, -1, { reason: "consumed", repairTicketId: ticket.id });
    const item = await createItemFor(shop, { productTitle: "Boot" });
    await createCover(warrantyCoverFor(item, await createWarrantyPolicyFor(shop)));
    await prisma.repairTicket.update({ where: { id: ticket.id }, data: { itemId: item.id } });

    await deliver(shopRedact, "shop/redact", shop.shopifyDomain, {});

    expect(await prisma.shop.count({ where: { id: shop.id } })).toBe(0);
    const counts = await Promise.all([
      prisma.part.count(),
      prisma.partVariant.count(),
      prisma.stockMovement.count(),
      prisma.ticketPart.count(),
      prisma.item.count(),
      prisma.cover.count(),
      prisma.repairService.count(),
    ]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(0);
  });

  describe("customers/redact", () => {
    const redact = (customer: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      deliver(customersRedact, "customers/redact", shop.shopifyDomain, { customer, ...extra });

    it("anonymises that customer's tickets, items and trade-ins", async () => {
      const ticket = await createRepairTicketFor(shop, { shopifyCustomerId: "9", customerEmail: "a@example.com", customerName: "A" });
      const item = await createItemFor(shop, { shopifyCustomerId: "9", customerEmail: "a@example.com", customerName: "A" });
      const tradeIn = await createTradeInFor(shop, { shopifyCustomerId: "9", customerEmail: "a@example.com", customerName: "A", description: "Worn" });

      await redact({ id: 9, email: "a@example.com" });

      expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } })).customerName).toBeNull();
      const i = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
      expect([i.customerEmail, i.shopifyCustomerId]).toEqual([null, null]);
      const t = await prisma.tradeIn.findUniqueOrThrow({ where: { id: tradeIn.id } });
      expect([t.customerEmail, t.customerName, t.description]).toEqual([null, null, "[redacted]"]);
    });

    it("matches by id or email (any case), leaving other customers alone", async () => {
      const mine = await createRepairTicketFor(shop, {
        shopifyCustomerId: "42",
        customerName: "Sam",
        customerEmail: "sam@example.com",
        customerPhone: "123",
        customerAddress: { city: "London" },
      });
      const sameEmail = await createRepairTicketFor(shop, { customerEmail: "SAM@example.com", customerName: "Sam (guest)" });
      const other = await createRepairTicketFor(shop, { shopifyCustomerId: "7", customerEmail: "other@example.com", customerName: "Other" });

      await redact({ id: 42, email: "sam@example.com" });

      for (const id of [mine.id, sameEmail.id]) {
        const t = await prisma.repairTicket.findUniqueOrThrow({ where: { id } });
        expect([t.customerName, t.customerEmail, t.shopifyCustomerId]).toEqual([null, null, null]);
      }
      expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: mine.id } })).customerAddress).toEqual({});
      expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: other.id } })).customerName).toBe("Other");
    });

    it("strips every place personal data lives, stored files included", async () => {
      const ticket = await createRepairTicketFor(shop, {
        shopifyCustomerId: "9",
        customerEmail: "Sam@Example.com",
        customerName: "Sam",
        customerPhone: "0123",
        description: "Torn sole, call me on 0123",
        postageSlipKey: "shops/1/tickets/9/postage-slip.pdf",
        postageSlipDigest: "abc",
      });
      const image = await createTicketImageFor(ticket.id);
      await storage.put(image.storageKey!, "jpeg");
      await storage.put("shops/1/tickets/9/postage-slip.pdf", "pdf");
      await createTicketActivityFor(ticket.id, { activityType: "note", body: "Sam rang about the boots" });
      await createTicketActivityFor(ticket.id, { activityType: "status_change", body: "Status changed from new to assessing." });
      await createQuotationFor(ticket.id, { status: "declined", decisionReason: "My dog chewed them" });
      const item = await createItemFor(shop, { customerEmail: "sam@example.com", properties: { engraving: "SAM" } });
      await storage.put("proofs/1.pdf", "pdf");
      await createRegistrationFor(shop, item.id, { proofKey: "proofs/1.pdf", proofFilename: "receipt.pdf", proofContentType: "application/pdf", proofByteSize: 3, reviewNote: "Sam's receipt" });
      await storage.put("trade-ins/1.jpg", "jpeg");
      const tradeIn = await createTradeInFor(shop, {
        shopifyCustomerId: "9",
        staffNote: "Sam says it's barely worn",
        photos: [{ key: "trade-ins/1.jpg", filename: "boot.jpg", contentType: "image/jpeg", byteSize: 4 }],
      });
      const pending = await createNotificationDeliveryFor(shop, {
        idempotencyKey: "k1",
        payload: { recipient: { customerId: "9", email: "sam@example.com", name: "Sam" }, data: { customerName: "Sam" } },
      });
      const otherDelivery = await createNotificationDeliveryFor(shop, {
        idempotencyKey: "k2",
        payload: { recipient: { customerId: "10", email: "other@example.com" }, data: {} },
      });

      await redact({ id: 9, email: "sam@example.com" });

      const t = await prisma.repairTicket.findUniqueOrThrow({
        where: { id: ticket.id },
        include: { activities: true, ticketImages: true, quotations: true },
      });
      expect([t.shopifyCustomerId, t.customerEmail, t.customerName, t.customerPhone, t.description]).toEqual([
        null, null, null, null, "[redacted]",
      ]);
      expect(t.ticketImages).toEqual([]);
      expect(await storage.get(image.storageKey!)).toBeNull();
      // The postage slip prints the customer's name and address.
      expect([t.postageSlipKey, t.postageSlipDigest]).toEqual([null, null]);
      expect(await storage.get("shops/1/tickets/9/postage-slip.pdf")).toBeNull();
      expect(t.activities.map((a) => a.body).sort()).toEqual([
        "Customer data redacted on request.",
        "Status changed from new to assessing.",
        "[redacted]",
      ]);
      expect(t.quotations[0].decisionReason).toBe("[redacted]");

      const i = await prisma.item.findUniqueOrThrow({ where: { id: item.id }, include: { registration: true } });
      expect([i.customerEmail, i.properties]).toEqual([null, {}]);
      expect([i.registration?.proofKey, i.registration?.reviewNote]).toEqual([null, null]);
      expect(await storage.get("proofs/1.pdf")).toBeNull();

      const tr = await prisma.tradeIn.findUniqueOrThrow({ where: { id: tradeIn.id } });
      expect([tr.staffNote, tr.photos]).toEqual([null, []]);
      expect(await storage.get("trade-ins/1.jpg")).toBeNull();

      const d = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: pending.id } });
      expect([d.status, d.payload]).toEqual(["skipped", { redacted: true }]);
      expect((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: otherDelivery.id } })).payload).toMatchObject({
        recipient: { customerId: "10" },
      });
    });

    it("matches items by the orders Shopify lists", async () => {
      const item = await createItemFor(shop, { orderId: "4001", customerName: "Guest" });
      await redact({}, { orders_to_redact: [4001] });
      expect((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).customerName).toBeNull();
    });

    it("does nothing without an id or email, and never touches another shop", async () => {
      const mine = await createRepairTicketFor(shop, { shopifyCustomerId: "42", customerName: "Sam" });
      const otherShop = await createShop({ shopifyDomain: "gdpr-other.myshopify.com" });
      const theirs = await createRepairTicketFor(otherShop, { shopifyCustomerId: "42", customerName: "Same id, other shop" });

      await redact({});
      expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: mine.id } })).customerName).toBe("Sam");

      await redact({ id: 42 });
      expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: mine.id } })).customerName).toBeNull();
      expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: theirs.id } })).customerName).toBe("Same id, other shop");
    });
  });

  describe("customers/data_request", () => {
    it("leaves data intact, stores a JSON export the admin lists, and fires the optional Flow trigger (no email)", async () => {
      shop = await prisma.shop.update({ where: { id: shop.id }, data: { settings: { notifications: { flow: true } } } });
      const ticket = await createRepairTicketFor(shop, {
        shopifyCustomerId: "9",
        customerEmail: "a@example.com",
        customerName: "A",
        postageSlipKey: "shops/1/tickets/1/postage-slip.pdf",
        postageSlipDigest: "abc",
      });
      await createTicketImageFor(ticket.id);
      await createQuotationFor(ticket.id, { status: "sent", decisionTokenDigest: "abc", decisionTokenCiphertext: "secret" });
      await createItemFor(shop, { customerEmail: "A@example.com" });
      await createRepairTicketFor(shop, { shopifyCustomerId: "10", customerName: "Other" });

      const payload = { customer: { id: 9, email: "a@example.com" }, orders_requested: [], data_request: { id: 9999 } };
      await deliver(dataRequest, "customers/data_request", shop.shopifyDomain, payload);
      await deliver(dataRequest, "customers/data_request", shop.shopifyDomain, payload); // retried

      expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } })).customerName).toBe("A");
      const key = "gdpr-exports/jobs-test.myshopify.com/9999.json";
      const exported = JSON.parse(new TextDecoder().decode((await storage.get(key))!.body));
      expect(exported.customer).toEqual({ shopify_customer_id: "9", email: "a@example.com", orders: [] });
      expect(exported.repair_tickets).toHaveLength(1);
      expect(exported.repair_tickets[0].customerName).toBe("A");
      expect(exported.repair_tickets[0].photos[0].url).toContain("/files/");
      expect(verifySignedUrl(new URL(exported.repair_tickets[0].postage_slip_url))).toBe("shops/1/tickets/1/postage-slip.pdf");
      expect(exported.repair_tickets[0]).not.toHaveProperty("postageSlipKey");
      expect(exported.repair_tickets[0].quotes[0]).not.toHaveProperty("decisionTokenCiphertext");
      expect(exported.items).toHaveLength(1);

      // Retried webhook: one entry, with who asked and what was found.
      const settings = (await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).settings as {
        gdpr_exports: Record<string, unknown>[];
      };
      expect(settings.gdpr_exports).toEqual([
        {
          key,
          request_id: "9999",
          created_at: expect.any(String),
          customer: "a@example.com",
          counts: { tickets: 1, items: 1, tradeIns: 0, deliveries: 0 },
        },
      ]);
      const alerts = await prisma.notificationDelivery.findMany({ where: { event: "data_request" } });
      expect(alerts.map((a) => [a.channel, a.idempotencyKey])).toEqual([["flow", "data_request:request_9999"]]);
      const data = (alerts[0].payload as { data: Record<string, string> }).data;
      expect(data).toMatchObject({
        customer: "a@example.com",
        summary: "1 repair ticket, 1 item, 0 trade-ins, 0 notifications",
        adminUrl: "https://admin.shopify.com/store/jobs-test/apps/shopcare/app/settings#data-requests",
      });
      expect(verifySignedUrl(new URL(data.downloadUrl))).toBe(key);
    });

    it("with Flow off, the export is still stored and nothing is sent", async () => {
      await deliver(dataRequest, "customers/data_request", shop.shopifyDomain, { customer: { id: 9 }, data_request: { id: 1 } });
      expect(await prisma.notificationDelivery.count()).toBe(0);
      const settings = (await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).settings as {
        gdpr_exports: { customer: string }[];
      };
      expect(settings.gdpr_exports.map((e) => e.customer)).toEqual(["customer 9"]);
    });
  });
});

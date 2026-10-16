/**
 * End-to-end scenarios across the storefront (App Proxy routes), the admin
 * services, the shared quote/ticket contract and Shopify webhooks, against
 * real Postgres and the Admin GraphQL fakes. Each one follows a repair (or a
 * Care plan) through every hand-off the separate suites test in isolation.
 */
import type { Shop } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../../app/db.server";
import { setWebhookJobDeps } from "../../../app/jobs/webhook.server";
import { MemoryStorage } from "../../../app/lib/storage.server";
import { decisionToken } from "../../../app/models/quotation.server";
import { action as intake } from "../../../app/routes/proxy.intake";
import { action as declinePage } from "../../../app/routes/proxy.quotes.$token_.decline";
import { loader as status } from "../../../app/routes/proxy.status";
import { action as customersRedact } from "../../../app/routes/webhooks.customers.redact";
import { action as ordersPaid } from "../../../app/routes/webhooks.orders.paid";
import { action as refundsCreate } from "../../../app/routes/webhooks.refunds.create";
import { addLineItem } from "../../../app/services/admin/tickets.server";
import type { EmailMessage } from "../../../app/services/email.server";
import { sendQuote } from "../../../app/services/quotes/send.server";
import { changeTicketStatus } from "../../../app/services/repairs/ticket-status.server";
import { buildCare, buildWorkshop } from "../../support/factories";
import { FakeDraftOrders } from "../../support/fake-draft-orders";
import { FakeGraphql } from "../../support/fake-graphql";
import {
  fakeStorefront,
  installedShop,
  pngFile,
  runRoute,
  signedGet,
  signedPost,
  type StorefrontFakes,
} from "../../support/proxy-routes";
import { dbNotifyDeps } from "../../support/quotes";
import { webhookRequest } from "../../support/shopify-requests";

const domain = "e2e-test.myshopify.com";
const CUSTOMER = "777";

type Action = typeof ordersPaid;
const deliver = (route: Action, topic: string, payload: unknown) =>
  route({
    request: webhookRequest(`/webhooks/${topic}`, { topic, shop: domain, payload }),
    params: {},
    context: {},
  } as Parameters<Action>[0]);

/** The admin's Shopify client: knows the "Resole" repair product (variant 900). */
const adminApi = () =>
  new FakeGraphql({
    "productVariant(id:": {
      productVariant: {
        id: "gid://shopify/ProductVariant/900",
        title: "Default Title",
        price: "60.00",
        product: { id: "gid://shopify/Product/90", title: "Resole" },
      },
    },
  });

describe("end-to-end scenarios", () => {
  let shop: Shop;
  let storefront: StorefrontFakes;
  let api: FakeDraftOrders;
  let storage: MemoryStorage;
  let notify: ReturnType<typeof dbNotifyDeps>;
  let sent: EmailMessage[];
  const outbound: unknown[] = [];

  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    notify = dbNotifyDeps();
    storage = new MemoryStorage();
    api = new FakeDraftOrders();
    sent = [];
    outbound.length = 0;
    shop = await installedShop(domain, {
      settings: { currency: "GBP", notifications: { staff_email: "workshop@e2e.test" } },
    });
    storefront = fakeStorefront(
      {},
      { adminClient: async () => api.client, storage: () => storage, notifications: () => notify.deps },
    );
    setWebhookJobDeps({
      client: async () => api.client,
      notifyDeps: notify.deps,
      storage,
      send: async (message) => {
        sent.push(message);
        return { id: `m${sent.length}`, adapter: "test" };
      },
      enqueue: async (_name, payload) => {
        outbound.push(payload);
      },
    });
  });
  afterEach(() => {
    storefront.restore();
    setWebhookJobDeps({});
    vi.restoreAllMocks();
  });

  const submitRepair = async (fields: Record<string, string | Blob | (string | Blob)[]>) => {
    const response = await runRoute(intake, signedPost("/proxy/intake", domain, fields, { customerId: CUSTOMER }));
    const body = (await response.json()) as { ok: boolean; ticket_id: number; errors?: string[] };
    expect(body).toMatchObject({ ok: true });
    return body.ticket_id;
  };
  const ticketOf = (id: number) => prisma.repairTicket.findUniqueOrThrow({ where: { id } });
  const quoteFor = (ticketId: number) =>
    prisma.quotation.findFirstOrThrow({ where: { repairTicketId: ticketId }, orderBy: { id: "desc" } });
  const events = async (event: string) =>
    (await prisma.notificationDelivery.findMany({ where: { event }, orderBy: { id: "asc" } })).map((d) => d.channel);

  it("(a) intake → quote → paid → in repair → completed (stock used) → shown on the status page", async () => {
    shop = await prisma.shop.update({
      where: { id: shop.id },
      data: { settings: { ...(shop.settings as object), parts_enabled: "1" } },
    });
    const { glue } = await buildWorkshop(shop);
    const glueVariant = await prisma.partVariant.findFirstOrThrow({ where: { partId: glue.id } });
    await prisma.partVariant.update({ where: { id: glueVariant.id }, data: { onHand: 500 } });

    // 1. The customer files a repair from the storefront, with a photo.
    const ticketId = await submitRepair({
      description: "Sole coming away at the toe",
      customer_email: "sarah@example.com",
      customer_name: "Sarah",
      product_title: "Aria Boot",
      "images[]": [pngFile()],
    });
    expect((await ticketOf(ticketId)).status).toBe("new");
    expect(await events("repair_submitted")).toEqual(expect.arrayContaining(["email", "staff_email"]));

    // 2. Staff build the quote in the admin (price from Shopify) and send it.
    expect(await addLineItem(shop, adminApi(), ticketId, { kind: "repair", variantId: "900", quantity: 1 } as never)).toEqual({
      notice: "Line item added.",
    });
    const draft = await quoteFor(ticketId);
    expect(Number(draft.subtotal)).toBe(60);
    const sentResult = await sendQuote({ shopId: shop.id, quotationId: draft.id, actor: "staff", client: api.client, enqueue: async () => {} });
    expect(sentResult).toEqual({ ok: true, warranty: false });
    expect(api.kinds()).toEqual(expect.arrayContaining(["create", "invoice"]));
    expect([(await ticketOf(ticketId)).status, (await quoteFor(ticketId)).status]).toEqual(["quoted", "sent"]);

    // 3. The customer pays the invoice: Shopify's orders/paid.
    const paid = {
      id: 5001,
      name: "#5001",
      tags: "repair",
      total_price: "60.00",
      currency: "GBP",
      customer: { id: Number(CUSTOMER) },
      note_attributes: [{ name: "repair_quotation_id", value: String(draft.id) }],
      line_items: [],
    };
    expect((await deliver(ordersPaid, "orders/paid", paid)).status).toBe(200);
    await deliver(ordersPaid, "orders/paid", paid); // retried delivery
    expect([(await ticketOf(ticketId)).status, (await quoteFor(ticketId)).status]).toEqual(["in_repair", "paid"]);
    expect(await events("quote_paid")).toContain("staff_email");
    expect(await prisma.item.count()).toBe(0); // a repair invoice isn't a purchase

    // 4. Staff complete the repair: recipe parts come out of stock.
    const done = await changeTicketStatus({ shopId: shop.id, ticketId, to: "completed", actor: "staff", client: api.client, enqueue: async () => {} });
    expect(done).toMatchObject({ ok: true, changed: true });
    expect(done.ok && done.message).toContain("1 part taken from stock");
    expect(Number((await prisma.partVariant.findUniqueOrThrow({ where: { id: glueVariant.id } })).onHand)).toBe(470);
    expect(await events("repair_status_changed")).toContain("email");

    // 5. The storefront status page shows it, completed.
    const page = (await (await runRoute(status, signedGet("/proxy/status", domain, { customerId: CUSTOMER }))).json()) as {
      tickets: { id: number; status: string; quotation: { status: string; subtotal: string } }[];
    };
    expect(page.tickets).toEqual([
      expect.objectContaining({ id: ticketId, status: "completed", quotation: expect.objectContaining({ status: "paid", subtotal: "60.00" }) }),
    ]);
  });

  it("(b) a Care plan bought with the boots covers a later repair: the £0 quote completes itself", async () => {
    const { plan } = await buildCare(shop);
    await deliver(ordersPaid, "orders/paid", {
      id: 6001,
      name: "#6001",
      tags: "",
      email: "sarah@example.com",
      processed_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      customer: { id: Number(CUSTOMER) },
      line_items: [
        { id: 1, product_id: 2, variant_id: 3, title: "Aria Boot", quantity: 1, price: "180.00", requires_shipping: true },
        { id: 2, product_id: 700, variant_id: 7001, title: "2-year Care", quantity: 1, price: "15.00" },
      ],
    });
    const item = await prisma.item.findFirstOrThrow({ where: { shopId: shop.id }, include: { covers: true } });
    expect(item.covers.map((c) => [c.kind, c.status, c.carePlanId])).toEqual([["care", "active", plan.id]]);
    expect(await events("care_activated")).not.toEqual([]);

    const ticketId = await submitRepair({ description: "Heel worn down", customer_email: "sarah@example.com", item_id: String(item.id) });
    expect(await ticketOf(ticketId)).toMatchObject({ itemId: item.id, coverId: item.covers[0].id });

    await addLineItem(shop, adminApi(), ticketId, { kind: "repair", variantId: "900", quantity: 1 } as never);
    const draft = await quoteFor(ticketId);
    expect([draft.coverId, Number(draft.subtotal)]).toEqual([item.covers[0].id, 0]);

    expect(await sendQuote({ shopId: shop.id, quotationId: draft.id, actor: "staff", client: api.client, enqueue: async () => {} })).toEqual({
      ok: true,
      warranty: true,
    });
    expect((await ticketOf(ticketId)).status).toBe("in_repair");
    expect((await quoteFor(ticketId)).status).toBe("paid");
    expect(api.kinds()).not.toContain("invoice"); // nothing to pay, so no invoice email
  });

  it("(c) declining on the review page deletes the draft order and alerts staff", async () => {
    const ticketId = await submitRepair({ description: "Stitching", customer_email: "sarah@example.com", product_title: "Boot" });
    await addLineItem(shop, adminApi(), ticketId, { kind: "repair", variantId: "900", quantity: 1 } as never);
    const draft = await quoteFor(ticketId);
    await sendQuote({ shopId: shop.id, quotationId: draft.id, actor: "staff", client: api.client, enqueue: async () => {} });
    const token = decisionToken(await quoteFor(ticketId))!;

    const response = await runRoute(
      declinePage,
      signedPost(`/proxy/quotes/${token}/decline`, domain, { reason: "Too dear" }),
      { token },
    );

    expect(response.status).toBe(200);
    const declined = await quoteFor(ticketId);
    expect([declined.status, declined.decisionReason]).toEqual(["declined", "Too dear"]);
    expect((await ticketOf(ticketId)).status).toBe("quote_declined");
    expect(api.kinds()).toContain("delete");
    const staff = await prisma.notificationDelivery.findFirstOrThrow({ where: { event: "quote_declined", channel: "staff_email" } });
    expect(staff.status).toBe("pending");
    expect(notify.enqueued).toContain(String(staff.id));
  });

  it("(d) refunding the Care line cancels the cover once, even when the webhook is delivered twice", async () => {
    await buildCare(shop);
    await deliver(ordersPaid, "orders/paid", {
      id: 7001,
      name: "#7001",
      tags: "",
      email: "sarah@example.com",
      customer: { id: Number(CUSTOMER) },
      line_items: [
        { id: 1, product_id: 2, variant_id: 3, title: "Aria Boot", quantity: 1, price: "180.00", requires_shipping: true },
        { id: 2, product_id: 700, variant_id: 7001, title: "2-year Care", quantity: 1, price: "15.00" },
      ],
    });
    const cover = await prisma.cover.findFirstOrThrow({ where: { kind: "care" } });
    const refund = { id: 801, order_id: 7001, refund_line_items: [{ line_item_id: 2, quantity: 1 }] };
    api.graphql.calls.length = 0;

    await Promise.all([
      deliver(refundsCreate, "refunds/create", refund),
      deliver(refundsCreate, "refunds/create", refund),
    ]);

    const after = await prisma.cover.findUniqueOrThrow({ where: { id: cover.id } });
    expect(after.status).toBe("cancelled");
    expect((after.usage as { refund: { action: string } }).refund.action).toBe("refunded_by_merchant");
    expect(await prisma.processedRefund.count()).toBe(1);
    expect(api.graphql.calls.filter((c) => c.query.includes("refundCreate"))).toEqual([]); // the merchant already refunded it
    const item = await prisma.item.findFirstOrThrow({ where: { orderLineId: "1" } });
    expect(item.status).toBe("active"); // the boots weren't refunded
  });

  it("(e) customers/redact removes the customer's personal data from every table and file", async () => {
    const ticketId = await submitRepair({
      description: "Call me on 07700 900123 about the boots",
      customer_email: "Sarah.Private@example.com",
      customer_name: "Sarah Private",
      customer_phone: "07700 900123",
      "customer_address[city]": "Lancaster",
      product_title: "Aria Boot",
      "images[]": [pngFile()],
    });
    const image = await prisma.ticketImage.findFirstOrThrow({ where: { repairTicketId: ticketId } });
    expect(await storage.get(image.storageKey!)).not.toBeNull();
    await deliver(ordersPaid, "orders/paid", {
      id: 8001,
      name: "#8001",
      tags: "",
      email: "sarah.private@example.com",
      customer: { id: Number(CUSTOMER), first_name: "Sarah", last_name: "Private" },
      line_items: [{ id: 1, product_id: 2, variant_id: 3, title: "Aria Boot", quantity: 1, price: "180.00" }],
    });
    expect(await prisma.item.count({ where: { shopifyCustomerId: CUSTOMER } })).toBe(1);

    await deliver(customersRedact, "customers/redact", { customer: { id: Number(CUSTOMER), email: "sarah.private@example.com" } });

    expect(await storage.get(image.storageKey!)).toBeNull();
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name NOT IN ('_prisma_migrations', 'Session')`;
    const leaks: string[] = [];
    for (const { table_name } of tables) {
      const rows = await prisma.$queryRawUnsafe<{ row: string }[]>(`SELECT row_to_json(t)::text AS row FROM "${table_name}" t`);
      for (const { row } of rows) {
        if (/sarah|private@|07700|lancaster/i.test(row)) leaks.push(`${table_name}: ${row.slice(0, 200)}`);
      }
    }
    expect(leaks).toEqual([]);
    expect(await ticketOf(ticketId)).toMatchObject({ shopifyCustomerId: null, customerEmail: null, description: "[redacted]" });
  });
});

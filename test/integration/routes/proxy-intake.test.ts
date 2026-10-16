/**
 * Port of Rails test/integration/proxy_intake_test.rb (POST /proxy/intake),
 * plus the Repairs::IntakeSubmission behaviour the route now owns end to end:
 * item verification (owned item, on-demand import, guest order token),
 * duplicate refusal, cover logging, photo limits, webhook + notification.
 */
import type { Shop } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
import { orderToken } from "../../../app/services/repairs/order-lookup.server";
import {
  ALREADY_OPEN,
  UNVERIFIED,
} from "../../../app/services/repairs/intake-submission.server";
import { action } from "../../../app/routes/proxy.intake";
import {
  createItemFor,
  createRepairTicketFor,
  createWarrantyCover,
  createWarrantyPolicyFor,
} from "../../support/factories";
import { orderNode } from "../../support/orders";
import {
  fakeStorefront,
  installedShop,
  pngFile,
  runRoute,
  signedPost,
  type StorefrontFakes,
} from "../../support/proxy-routes";

const domain = "proxy-test.myshopify.com";

describe("POST /proxy/intake", () => {
  let shop: Shop;
  let fakes: StorefrontFakes;

  beforeEach(async () => {
    shop = await installedShop(domain, { settings: { webhook_url: "https://hooks.example.com/shopcare" } });
    fakes = fakeStorefront();
  });
  afterEach(() => fakes.restore());

  const post = (fields: Parameters<typeof signedPost>[2], customerId = "777", shopDomain = domain) =>
    runRoute(action, signedPost("/proxy/intake", shopDomain, fields, { customerId }));
  const json = async (response: Response) => (await response.json()) as Record<string, never>;

  it("creates a ticket on a correctly signed request", async () => {
    const response = await post({ description: "Sole peeling", customer_email: "c@example.com" });

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.ok).toBe(true);
    const ticket = await prisma.repairTicket.findUniqueOrThrow({ where: { id: body.ticket_id } });
    expect(ticket.shopId).toBe(shop.id);
    expect(ticket.shopifyCustomerId).toBe("777"); // from the trusted proxy param
    expect(ticket.status).toBe("new");
    const activities = await prisma.ticketActivity.findMany({ where: { repairTicketId: ticket.id } });
    expect(activities.map((a) => [a.author, a.body])).toEqual([
      ["customer", "Repair request submitted via storefront."],
    ]);
  });

  it("rejects a request with an invalid signature", async () => {
    const signed = new URL(signedPost("/proxy/intake", domain).url);
    signed.searchParams.set("signature", "deadbeef");
    const body = new FormData();
    body.append("description", "x");
    body.append("customer_email", "c@example.com");
    await expect(runRoute(action, new Request(signed, { method: "POST", body }))).rejects.toMatchObject({
      status: 400,
    });
    expect(await prisma.repairTicket.count()).toBe(0);
  });

  it("returns 422 when required fields are missing", async () => {
    const response = await post({ customer_email: "" });
    expect(response.status).toBe(422);
    const body = await json(response);
    expect(body.ok).toBe(false);
    expect(body.errors).toEqual(["description is required", "customer_email is required"]);
  });

  it("returns 422 with Rails' validation message for a bad email", async () => {
    const response = await post({ description: "x", customer_email: "not-an-email" });
    expect(response.status).toBe(422);
    expect((await json(response)).errors).toEqual(["Validation failed: Customer email is invalid"]);
  });

  it("returns 404 for an unknown shop", async () => {
    const response = await post({ description: "x", customer_email: "c@example.com" }, "777", "ghost.myshopify.com");
    expect(response.status).toBe(404);
  });

  it("accepts a multipart submission with an image upload; other files are skipped", async () => {
    const response = await post({
      description: "Cracked sole",
      customer_email: "c@example.com",
      "images[]": [pngFile(), new File(["%PDF"], "receipt.pdf", { type: "application/pdf" })],
    });

    expect(response.status).toBe(200);
    const images = await prisma.ticketImage.findMany({ where: { repairTicketId: (await json(response)).ticket_id } });
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ contentType: "image/png", filename: "repair.png" });
    const stored = await fakes.storage.get(images[0].storageKey!);
    expect(stored?.contentType).toBe("image/png");
    expect(stored?.body.byteLength).toBe(images[0].byteSize);
  });

  it("keeps at most the shop's max_images photos", async () => {
    await prisma.shop.update({ where: { id: shop.id }, data: { settings: { intake: { max_images: 2 } } } });
    const response = await post({
      description: "Scuffs",
      customer_email: "c@example.com",
      "images[]": [pngFile("a.png"), pngFile("b.png"), pngFile("c.png")],
    });
    expect(await prisma.ticketImage.count({ where: { repairTicketId: (await json(response)).ticket_id } })).toBe(2);
  });

  it("files a logged-in customer's own item with its cover, and logs the cover", async () => {
    const policy = await createWarrantyPolicyFor(shop, { name: "12-month warranty", months: 12 });
    const item = await createItemFor(shop, {
      shopifyCustomerId: "777",
      productTitle: "Aria Boot",
      variantTitle: "UK 7",
      orderName: "#1042",
      orderLineId: "55",
    });
    const cover = await createWarrantyCover(shop, { item, policy });

    const body = await json(
      await post({ description: "Sole", customer_email: "c@example.com", item_id: String(item.id), product_title: "Spoofed" }),
    );

    const ticket = await prisma.repairTicket.findUniqueOrThrow({ where: { id: body.ticket_id } });
    expect(ticket).toMatchObject({ itemId: item.id, coverId: cover.id, inWarranty: true, productTitle: "Aria Boot", orderNumber: "#1042" });
    const log = await prisma.ticketActivity.findFirstOrThrow({ where: { repairTicketId: ticket.id, author: "system" } });
    expect(log.body).toMatch(/^Covered by 12-month warranty until [A-Z][a-z]+ [ \d]\d, \d{4} \(free repair\)\.$/);
  });

  it("imports an old order on demand to verify a purchase", async () => {
    fakes.restore();
    fakes = fakeStorefront({ "order(id:": { order: orderNode(9, { customerId: "777", lines: [{ id: "55", quantity: 1 }] }) } });

    const response = await post({ description: "Sole", customer_email: "c@example.com", order_id: "9", order_line_id: "55" });

    expect(response.status).toBe(200);
    const ticket = await prisma.repairTicket.findUniqueOrThrow({ where: { id: (await json(response)).ticket_id } });
    expect(ticket.itemId).not.toBeNull();
  });

  it("refuses an order line that isn't the customer's", async () => {
    fakes.restore();
    fakes = fakeStorefront({ "order(id:": { order: orderNode(9, { customerId: "888", lines: [{ id: "55", quantity: 1 }] }) } });

    const response = await post({ description: "Sole", customer_email: "c@example.com", order_id: "9", order_line_id: "55" });

    expect(response.status).toBe(422);
    expect((await json(response)).errors).toEqual([UNVERIFIED]);
  });

  it("a guest files a line of an order they verified (signed token), and a forged token is refused", async () => {
    const item = await createItemFor(shop, { orderId: "9", orderLineId: "55", productTitle: "Aria Boot" });

    const ok = await post(
      { description: "Sole", customer_email: "g@example.com", order_token: orderToken(shop, "9"), order_line_id: "55" },
      "",
    );
    expect(ok.status).toBe(200);
    const ticket = await prisma.repairTicket.findUniqueOrThrow({ where: { id: (await json(ok)).ticket_id } });
    expect(ticket).toMatchObject({ itemId: item.id, shopifyCustomerId: null });

    const forged = await post(
      { description: "Sole", customer_email: "g@example.com", order_token: `${orderToken(shop, "9")}x`, order_line_id: "56" },
      "",
    );
    expect(forged.status).toBe(422);
    expect((await json(forged)).errors).toEqual([UNVERIFIED]);
  });

  it("refuses a second request while a repair is open for the item", async () => {
    const item = await createItemFor(shop, { shopifyCustomerId: "777", orderLineId: "55" });
    await createRepairTicketFor(shop, { itemId: item.id, status: "assessing" });

    const response = await post({ description: "Again", customer_email: "c@example.com", item_id: String(item.id) });

    expect(response.status).toBe(422);
    expect((await json(response)).errors).toEqual([ALREADY_OPEN]);
  });

  it("records an unverified catalogue pick, the address and the order date", async () => {
    const response = await post(
      {
        description: "Heel worn",
        customer_email: "g@example.com",
        product_id: "10",
        variant_id: "101",
        variant_title: "UK 8",
        unverified_purchase: "true",
        order_date: "2026-09-01",
        "customer_address[city]": "London",
        "customer_address[zip]": "",
      },
      "",
    );

    const ticket = await prisma.repairTicket.findUniqueOrThrow({ where: { id: (await json(response)).ticket_id } });
    expect(ticket).toMatchObject({ productId: "10", variantId: "101", itemId: null, customerAddress: { city: "London" } });
    expect(ticket.orderDate?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    const log = await prisma.ticketActivity.findFirstOrThrow({ where: { repairTicketId: ticket.id, author: "system" } });
    expect(log.body).toBe("Product chosen from the catalogue: purchase not verified, no cover applied.");
  });

  it("queues the outbound webhook and emits repair_submitted", async () => {
    const body = await json(await post({ description: "Sole", customer_email: "c@example.com", product_title: "Boot" }));

    expect(fakes.enqueued).toEqual([
      { name: "outbound-webhook", payload: { shopId: String(shop.id), ticketId: String(body.ticket_id), event: "submitted" } },
    ]);
    const deliveries = [...fakes.notifications.store.deliveries.values()];
    expect(deliveries.map((d) => [d.event, d.channel])).toEqual(
      expect.arrayContaining([["repair_submitted", "email"]]),
    );
  });
});

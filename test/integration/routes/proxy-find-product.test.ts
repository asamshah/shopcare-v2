/**
 * Port of Rails test/integration/proxy_find_product_test.rb: the repair
 * form's "Find the product you bought" (catalogue search and order lookup
 * through the signed App Proxy), the rate limit, and the intake refusing a
 * spoofed item. Rails stubbed the services; here the Admin API is faked, so
 * the routes run their real services.
 */
import type { Shop } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
import { verifiedOrderId } from "../../../app/services/repairs/order-lookup.server";
import { UNVERIFIED } from "../../../app/services/repairs/intake-submission.server";
import { action as intake } from "../../../app/routes/proxy.intake";
import { loader as catalogSearch } from "../../../app/routes/proxy.catalog_search";
import { action as orderLookup, NOT_FOUND } from "../../../app/routes/proxy.order_lookup";
import { buildCare, createItemFor, createWarrantyPolicyFor } from "../../support/factories";
import { orderNode } from "../../support/orders";
import {
  fakeStorefront,
  installedShop,
  runRoute,
  signedGet,
  signedPost,
  type StorefrontFakes,
} from "../../support/proxy-routes";

const domain = "find-test.myshopify.com";

const product = (id: string, title: string, variants: { id: string; title: string; sku?: string }[]) => ({
  id: `gid://shopify/Product/${id}`,
  title,
  featuredMedia: { preview: { image: { url: `https://cdn/${id}.jpg` } } },
  variants: {
    nodes: variants.map((v) => ({
      id: `gid://shopify/ProductVariant/${v.id}`,
      title: v.title,
      sku: v.sku ?? null,
      media: { nodes: [] },
    })),
  },
});

describe("Find the product you bought (App Proxy)", () => {
  let shop: Shop;
  let fakes: StorefrontFakes;

  beforeEach(async () => {
    shop = await installedShop(domain);
  });
  afterEach(() => fakes?.restore());

  const lookupNode = (customerId: string | null = null) =>
    orderNode(9, {
      name: "#1042",
      email: "sarah@example.com",
      customerId,
      lines: [{ id: "55", quantity: 1, imageUrl: "https://cdn/aria.jpg" }],
    });

  it("catalogue search answers guests with public catalogue facts, CDN-cacheable", async () => {
    const { plan } = await buildCare(shop);
    fakes = fakeStorefront({
      "products(first:": {
        products: {
          nodes: [
            product("10", "Aria Boot", [
              { id: "100", title: "UK 7" },
              { id: "101", title: "UK 8" },
            ]),
            product("11", "Aria Sandal", [{ id: "110", title: "Default Title", sku: "SAN-1" }]),
            product("700", "Care", [{ id: plan.shopifyVariantId, title: "Default Title" }]),
          ],
        },
      },
    });

    const response = await runRoute(catalogSearch, signedGet("/proxy/catalog_search", domain, { extra: { q: "aria" } }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      results: [
        {
          product_id: "10",
          product_title: "Aria Boot",
          image_url: "https://cdn/10.jpg",
          variants: [
            { variant_id: "100", variant_title: "UK 7", sku: null },
            { variant_id: "101", variant_title: "UK 8", sku: null },
          ],
        },
        {
          product_id: "11",
          product_title: "Aria Sandal",
          image_url: "https://cdn/11.jpg",
          variant_id: "110",
          sku: "SAN-1",
        },
      ],
    });
    expect(response.headers.get("Netlify-Vary")).toBe("query=shop|q");
  });

  it("catalogue search needs Shopify's signature", async () => {
    fakes = fakeStorefront();
    const unsigned = new Request(`https://shopcare.test/proxy/catalog_search?shop=${domain}&q=aria&signature=deadbeef`);
    await expect(runRoute(catalogSearch, unsigned)).rejects.toMatchObject({ status: 400 });
  });

  it("a guest's order lookup returns the order's lines with their cover, and a token for the intake", async () => {
    await createWarrantyPolicyFor(shop, { name: "12-month warranty", months: 12 });
    fakes = fakeStorefront({ "orders(first:": { orders: { nodes: [lookupNode()] } } });

    const response = await runRoute(
      orderLookup,
      signedPost("/proxy/order_lookup", domain, { order_number: "1042", email: "sarah@example.com" }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { products: Record<string, never>[]; order_token: string; order_name: string };
    expect(body.order_name).toBe("#1042");
    const card = body.products[0];
    expect(body.products).toHaveLength(1);
    expect([card.product_title, card.variant_title, card.order_name, card.order_line_id, card.image_url]).toEqual([
      "Aria Boot",
      "UK 7",
      "#1042",
      "55",
      "https://cdn/aria.jpg",
    ]);
    const cover = card.cover as Record<string, string>;
    expect([cover.kind, cover.name]).toEqual(["warranty", "12-month warranty"]);
    expect(verifiedOrderId(shop, body.order_token)).toBe("9");
  });

  it("a logged-in customer's lookup is limited to their orders and needs no email or token", async () => {
    fakes = fakeStorefront({ "orders(first:": { orders: { nodes: [lookupNode("777")] } } });

    const response = await runRoute(
      orderLookup,
      signedPost("/proxy/order_lookup", domain, { order_number: "1042", email: "ignored@example.com" }, { customerId: "777" }),
    );

    const body = (await response.json()) as Record<string, unknown[]>;
    expect(body.products).toHaveLength(1);
    expect(body).not.toHaveProperty("order_token");

    // Someone else's order is the same generic miss.
    fakes.restore();
    fakes = fakeStorefront({ "orders(first:": { orders: { nodes: [lookupNode("888")] } } });
    const other = await runRoute(
      orderLookup,
      signedPost("/proxy/order_lookup", domain, { order_number: "1042" }, { customerId: "777" }),
    );
    expect(other.status).toBe(404);
  });

  it("any mismatch is the same generic not found", async () => {
    fakes = fakeStorefront({ "orders(first:": { orders: { nodes: [lookupNode()] } } });

    const response = await runRoute(
      orderLookup,
      signedPost("/proxy/order_lookup", domain, { order_number: "1042", email: "wrong@example.com" }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: NOT_FOUND });
  });

  it("order lookups are rate-limited per visitor, then per shop", async () => {
    fakes = fakeStorefront({ "orders(first:": { orders: { nodes: [] } } });
    const post = (ip: string) =>
      runRoute(
        orderLookup,
        signedPost("/proxy/order_lookup", domain, { order_number: "1", email: "a@example.com" }, {
          headers: { "x-forwarded-for": ip },
        }),
      );

    for (let i = 0; i < 10; i++) expect((await post("203.0.113.5")).status).toBe(404);
    expect((await post("203.0.113.5")).status).toBe(429);
    expect((await post("198.51.100.7")).status).toBe(404); // another visitor isn't blocked

    // The per-shop ceiling (300 per 10 minutes) across many visitors.
    // 11 counted so far (the blocked request stops at its IP counter, as Rails).
    for (let i = 0; i < 289; i++) await post(`192.0.2.${i % 250}`);
    expect((await post("192.0.2.251")).status).toBe(429);
  });

  it("intake refuses a guest's spoofed item id", async () => {
    fakes = fakeStorefront();
    const item = await createItemFor(shop, { shopifyCustomerId: "111", productTitle: "Aria Boot", orderLineId: "55" });

    const response = await runRoute(
      intake,
      signedPost("/proxy/intake", domain, { description: "Sole", customer_email: "c@example.com", item_id: String(item.id) }),
    );

    expect(response.status).toBe(422);
    expect(((await response.json()) as { errors: string[] }).errors).toEqual([UNVERIFIED]);
    expect(await prisma.repairTicket.count()).toBe(0);
  });
});

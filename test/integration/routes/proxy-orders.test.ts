/** Port of Rails test/integration/proxy_orders_test.rb (GET /proxy/orders). */
import type { Shop } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signCustomerToken } from "../../../app/lib/customer-token.server";
import { addMonths } from "../../../app/lib/dates";
import { careCoverFor, createCover } from "../../../app/models/cover.server";
import { setShopSecret } from "../../../app/models/shop.server";
import { loader } from "../../../app/routes/proxy.orders";
import {
  buildCare,
  createItemFor,
  createRepairTicketFor,
  createWarrantyCover,
  createWarrantyPolicyFor,
  daysAgo,
} from "../../support/factories";
import {
  fakeStorefront,
  historyOrder,
  installedShop,
  purchaseHistory,
  runRoute,
  signedGet,
  type StorefrontFakes,
} from "../../support/proxy-routes";

const domain = "orders-test.myshopify.com";
const KEY = "k".repeat(64);

describe("GET /proxy/orders", () => {
  let shop: Shop;
  let fakes: StorefrontFakes;

  beforeEach(async () => {
    shop = await installedShop(domain);
  });
  afterEach(() => fakes?.restore());

  const get = (opts: Parameters<typeof signedGet>[2] = {}) =>
    runRoute(loader, signedGet("/proxy/orders", domain, opts));
  const body = async (response: Response) => (await response.json()) as Record<string, never>;

  // The token the blocks' Liquid signs (snippets/shopcare_customer_query).
  const tokenQuery = (customerId: string, key: string, ts = Math.floor(Date.now() / 1000)) => ({
    customer_id: customerId,
    customer_ts: String(ts),
    customer_sig: signCustomerToken(key, customerId, String(ts)),
  });

  it("returns the customer's purchased products", async () => {
    fakes = fakeStorefront(
      purchaseHistory([
        historyOrder({
          id: "9",
          name: "#1042",
          lines: [
            {
              id: "55",
              productId: "10",
              variantId: "100",
              productTitle: "Aria Boot",
              variantTitle: "UK 9",
              imageUrl: "https://cdn/x.jpg",
            },
          ],
        }),
      ]),
    );

    const response = await get({ customerId: "777" });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const json = await body(response);
    expect(json.logged_in).toBe(true);
    expect(json.products).toEqual([
      {
        product_id: "10",
        variant_id: "100",
        product_title: "Aria Boot",
        variant_title: "UK 9",
        image_url: "https://cdn/x.jpg",
        order_name: "#1042",
        order_date: "2026-01-01T00:00:00Z",
        order_id: "9",
        order_line_id: "55",
      },
    ]);
    expect(fakes.api.calls[0].variables.id).toBe("gid://shopify/Customer/777");
  });

  it("reports not-logged-in with no customer id", async () => {
    fakes = fakeStorefront();
    expect(await body(await get())).toEqual({ ok: true, logged_in: false, products: [] });
  });

  it("ignores a browser-supplied customer id (the visitor controls the signed query)", async () => {
    fakes = fakeStorefront();
    const json = await body(await get({ extra: { customer_id: "777" } }));
    expect(json.logged_in).toBe(false);
    expect(json.products).toEqual([]);
    expect(fakes.api.calls).toHaveLength(0);
  });

  it("rejects an unsigned request", async () => {
    fakes = fakeStorefront();
    const unsigned = new Request(
      `https://shopcare.test/proxy/orders?shop=${domain}&logged_in_customer_id=777&signature=deadbeef`,
    );
    await expect(runRoute(loader, unsigned)).rejects.toMatchObject({ status: 400 });
  });

  it("includes each purchase's item cover and the customer's registered products", async () => {
    const policy = await createWarrantyPolicyFor(shop, { name: "12-month warranty", months: 12 });
    const bought = await createItemFor(shop, {
      shopifyCustomerId: "777",
      productTitle: "Aria Boot",
      orderLineId: "55",
      purchasedAt: daysAgo(30),
    });
    await createWarrantyCover(shop, { item: bought, policy });
    const registered = await createItemFor(shop, {
      shopifyCustomerId: "777",
      productTitle: "Trail Runner",
      source: "registration",
      purchasedAt: daysAgo(60),
    });
    await createItemFor(shop, { shopifyCustomerId: "888", productTitle: "Someone else's", source: "registration" });
    fakes = fakeStorefront(
      purchaseHistory([
        historyOrder({ id: "9", name: "#1042", lines: [{ id: "55", productId: "10", variantId: "100" }] }),
      ]),
    );

    const products = (await body(await get({ customerId: "777" }))).products as Record<string, never>[];

    expect(products.map((p) => p.item_id)).toEqual([bought.id, registered.id]);
    const cover = products[0].cover as Record<string, string>;
    expect([cover.name, cover.badge]).toEqual(["12-month warranty", "12-month warranty"]);
    expect(cover.statutory_rights).toContain("does not affect, your statutory rights");
    expect(products[0].order_line_id).toBe("55");
    expect(products[1].cover).toBeUndefined();
    expect(products[1].order_name).toBe("Registered");
  });

  it("cards carry Care with its end date, and a repair already open", async () => {
    const { plan } = await buildCare(shop);
    const covered = await createItemFor(shop, {
      shopifyCustomerId: "777",
      productTitle: "Aria Boot",
      orderLineId: "55",
      purchasedAt: daysAgo(31),
    });
    await createCover(careCoverFor(covered, plan));
    const repairing = await createItemFor(shop, {
      shopifyCustomerId: "777",
      productTitle: "Trail Runner",
      orderLineId: "56",
      purchasedAt: daysAgo(60),
    });
    await createRepairTicketFor(shop, { itemId: repairing.id, customerEmail: "c@example.com", status: "assessing" });
    fakes = fakeStorefront(
      purchaseHistory([
        historyOrder({ id: "9", name: "#1042", lines: [{ id: "55", productTitle: "Aria Boot" }] }),
        historyOrder({ id: "10", name: "#1043", lines: [{ id: "56", productTitle: "Trail Runner" }] }),
      ]),
    );

    const [aria, runner] = (await body(await get({ customerId: "777" }))).products as Record<
      string,
      Record<string, string>
    >[];

    expect([aria.cover.kind, aria.cover.name, aria.cover.ends_at]).toEqual([
      "care",
      "2-year Care",
      addMonths(covered.purchasedAt!, 24).toISOString().slice(0, 10),
    ]);
    expect(aria.cover).not.toHaveProperty("remaining");
    expect(aria.cover.badge).toBe("ShopCare – 2 year plan");
    expect(aria.open_ticket).toBeUndefined();
    expect(runner.open_ticket.status_label).toBe("Assessing");
  });

  it("a signed customer token stands in for a missing logged_in_customer_id", async () => {
    await setShopSecret(shop.id, "customerSigningKey", KEY);
    fakes = fakeStorefront(purchaseHistory([]));

    const json = await body(await get({ extra: tokenQuery("777", KEY) }));

    expect(json.logged_in).toBe(true);
    expect(fakes.api.calls[0].variables.id).toBe("gid://shopify/Customer/777");
  });

  it("a tampered, expired or other shop's token is treated as logged out", async () => {
    await setShopSecret(shop.id, "customerSigningKey", KEY);
    fakes = fakeStorefront();
    const tampered = { ...tokenQuery("777", KEY), customer_id: "778" };
    const expired = tokenQuery("777", KEY, Math.floor(Date.now() / 1000) - 25 * 3600);
    const otherShop = tokenQuery("777", "o".repeat(64));
    for (const query of [tampered, expired, otherShop]) {
      expect((await body(await get({ extra: query }))).logged_in).toBe(false);
    }
    expect(fakes.api.calls).toHaveLength(0);
  });

  it("without a signing key a token is ignored", async () => {
    fakes = fakeStorefront();
    const response = await get({ extra: tokenQuery("777", "") });
    expect(response.status).toBe(200);
    expect((await body(response)).logged_in).toBe(false);
    expect(fakes.api.calls).toHaveLength(0);
  });

  it("logged_in_customer_id wins over a token", async () => {
    await setShopSecret(shop.id, "customerSigningKey", KEY);
    fakes = fakeStorefront(purchaseHistory([]));

    const json = await body(await get({ customerId: "555", extra: tokenQuery("777", KEY) }));

    expect(json.logged_in).toBe(true);
    expect(fakes.api.calls[0].variables.id).toBe("gid://shopify/Customer/555");
  });

  it("404s a shop that hasn't installed the app", async () => {
    fakes = fakeStorefront();
    const response = await runRoute(loader, signedGet("/proxy/orders", "ghost.myshopify.com", { customerId: "777" }));
    expect(response.status).toBe(404);
  });
});

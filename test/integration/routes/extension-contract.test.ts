/**
 * The theme extension's contract with the App Proxy. The extension (copied
 * unchanged from Rails) is tested in jsdom against mocked proxy responses
 * (Rails test/storefront/storefront.test.js); those mocks are the JSON its JS
 * reads. Here each mock is replayed against the real route, called the way
 * the extension calls it (same method, query and form fields), and the
 * answer must carry every key the mock has, with the same JSON type, all the
 * way down. Fixtures below are copied verbatim from storefront.test.js.
 */
import type { Shop } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
import { careCoverFor, createCover } from "../../../app/models/cover.server";
import { issueDecisionToken } from "../../../app/models/quotation.server";
import { loader as carePlans } from "../../../app/routes/proxy.care_plans";
import { loader as careOffers } from "../../../app/routes/proxy.care_offers";
import { loader as catalogSearch } from "../../../app/routes/proxy.catalog_search";
import { action as intake } from "../../../app/routes/proxy.intake";
import { action as orderLookup } from "../../../app/routes/proxy.order_lookup";
import { loader as orders } from "../../../app/routes/proxy.orders";
import { loader as status } from "../../../app/routes/proxy.status";
import {
  buildCare,
  createItemFor,
  createQuotationFor,
  createRepairTicketFor,
  createWarrantyCover,
  createWarrantyPolicyFor,
  daysAgo,
  WORKSHOP_SETTINGS,
} from "../../support/factories";
import { orderNode } from "../../support/orders";
import {
  fakeStorefront,
  historyOrder,
  installedShop,
  purchaseHistory,
  runRoute,
  signedGet,
  signedPost,
  type StorefrontFakes,
} from "../../support/proxy-routes";

// --- storefront.test.js fixtures ---------------------------------------------

const PLAN = { id: 1, name: "2-year Care", variant_id: "7001", price: "15.00", term_months: 24, benefits: ["Free repairs"], terms: [] };
const CARE_PLANS = { ok: true, currency: "GBP", plans: [{ id: 1, name: "2-year Care", variant_id: "7001", price: "15.00", term_months: 24, benefits: ["Free repairs"], exclusions: ["Theft or loss"], terms: ["All repairs to your Boot for 2 years, except: theft or loss.", "This plan is in addition to, and does not affect, your statutory rights."] }] };
const PRODUCTS = [
  { product_id: "10", variant_id: "100", product_title: "Aria Boot", variant_title: "UK 7", order_name: "#1042", order_date: "2026-09-01", order_id: "9", order_line_id: "55", item_id: 3,
    cover: { kind: "care", name: "2-year Care", badge: "ShopCare – 2 year plan", outcome: "Free repairs", ends_at: "2028-09-01", statutory_rights: "This plan is in addition to, and does not affect, your statutory rights." } },
  { product_id: "11", variant_id: "110", product_title: "Trail Runner", order_name: "#1043", order_id: "10", order_line_id: "56", item_id: 4,
    cover: { kind: "warranty", name: "12-month warranty", badge: "12-month warranty", outcome: "Free repair", ends_at: "2027-03-12" } },
  { product_id: "12", variant_id: "120", product_title: "Derby Shoe", order_name: "#1001", order_id: "11", order_line_id: "57", item_id: 5,
    open_ticket: { id: 8, status: "assessing", status_label: "Assessing" } },
];
const ORDERS = { ok: true, logged_in: true, products: PRODUCTS };
const ORDERS_LOGGED_OUT = { ok: true, products: [] };
const CATALOG = { ok: true, results: [
  { product_id: "10", product_title: "Aria Boot", image_url: "https://cdn/10.jpg", variants: [{ variant_id: "100", variant_title: "UK 7" }, { variant_id: "101", variant_title: "UK 8" }] },
  { product_id: "11", product_title: "Aria Sandal", variant_id: "110", sku: "SAN-1" },
] };
const LOOKUP_FOUND = { ok: true, order_name: "#1042", order_token: "signed-token", products: [PRODUCTS[0]] };
const LOOKUP_MISS = { ok: false, error: "We couldn't find that order. Check the order number, and the email address you used at checkout." };
const INTAKE_OK = { ok: true, ticket_id: 1 };
const INTAKE_REFUSED = { ok: false, errors: ["We couldn't confirm that purchase. Please choose it again, or describe the item instead."] };
const STATUS = { ok: true, logged_in: true, tickets: [
  { id: 7, status_label: "Quoted", product_title: "Boot", cover: { kind: "care", name: "18-month Care", badge: "ShopCare – 18 month plan", ends_at: "2028-03-01" }, quotation: { status: "sent", currency: "GBP", subtotal: "24.00", review_url: "/apps/repairs/quotes/abc" } },
  { id: 8, status_label: "Quoted", product_title: "Shoe", quotation: { status: "paid", currency: "GBP", subtotal: "18.00" } },
  { id: 9, status_label: "Completed", product_title: "Sandal", cover: { kind: "warranty", name: "12-month warranty", badge: "12-month warranty", ends_at: "2027-03-12" } },
  { id: 10, status: "awaiting_item", status_label: "Awaiting item", product_title: "Loafer", quotation: { status: "paid", currency: "GBP", subtotal: "30.00" }, postage_slip_url: "/apps/repairs/tickets/10/postage-slip?expires=1793000000&token=abc" },
] };
const CARE_OFFERS = { ok: true, logged_in: true, currency: "GBP", items: [
  { item_id: 3, product_title: "Aria Boot", plans: [Object.assign({}, PLAN, { badge: "ShopCare – 2 year plan", offer_ends: "2026-11-01", cover_ends: "2028-10-02" })] },
] };

// --- shape check -----------------------------------------------------------------

const kind = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

/** Every key in `fixture` is in `actual` with the same JSON type; arrays element by element. */
function expectCovers(actual: unknown, fixture: unknown, path = "$") {
  expect(kind(actual), path).toBe(kind(fixture));
  if (Array.isArray(fixture)) {
    const list = actual as unknown[];
    expect(list.length, `${path} has items`).toBeGreaterThanOrEqual(Math.min(fixture.length, 1));
    fixture.forEach((item, i) => {
      if (i < list.length) expectCovers(list[i], item, `${path}[${i}]`);
    });
  } else if (fixture && typeof fixture === "object") {
    for (const [key, value] of Object.entries(fixture)) {
      expect(actual as object, `${path}.${key}`).toHaveProperty([key]);
      expectCovers((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
    }
  }
}

const domain = "contract-test.myshopify.com";

describe("extension contract: the storefront fixtures replayed against the routes", () => {
  let shop: Shop;
  let fakes: StorefrontFakes;

  beforeEach(async () => {
    shop = await installedShop(domain, { settings: { currency: "GBP" } });
  });
  afterEach(() => fakes?.restore());

  it("care_plans (PDP care_offer block: ?product_id=…&product_title=…)", async () => {
    await buildCare(shop);
    fakes = fakeStorefront();
    const response = await runRoute(
      carePlans,
      signedGet("/proxy/care_plans", domain, { extra: { product_id: "10", product_title: "Boot" } }),
    );
    const body = await response.json();
    expectCovers(body, CARE_PLANS);
    expectCovers((body as typeof CARE_PLANS).plans[0], PLAN);
  });

  async function ordersState() {
    const { plan } = await buildCare(shop);
    const policy = await createWarrantyPolicyFor(shop, { name: "12-month warranty", months: 12 });
    const aria = await createItemFor(shop, { shopifyCustomerId: "77", productTitle: "Aria Boot", orderId: "9", orderLineId: "55", purchasedAt: daysAgo(30) });
    await createCover(careCoverFor(aria, plan));
    const runner = await createItemFor(shop, { shopifyCustomerId: "77", productTitle: "Trail Runner", orderId: "10", orderLineId: "56", purchasedAt: daysAgo(60) });
    await createWarrantyCover(shop, { item: runner, policy });
    const derby = await createItemFor(shop, { shopifyCustomerId: "77", productTitle: "Derby Shoe", orderId: "11", orderLineId: "57", purchasedAt: daysAgo(90) });
    await createRepairTicketFor(shop, { itemId: derby.id, status: "assessing" });
    return { plan };
  }

  it("orders (repair form, logged in and out)", async () => {
    await ordersState();
    fakes = fakeStorefront(
      purchaseHistory([
        historyOrder({ id: "9", name: "#1042", lines: [{ id: "55", productId: "10", variantId: "100", productTitle: "Aria Boot", variantTitle: "UK 7" }] }),
        historyOrder({ id: "10", name: "#1043", lines: [{ id: "56", productId: "11", variantId: "110", productTitle: "Trail Runner" }] }),
        historyOrder({ id: "11", name: "#1001", lines: [{ id: "57", productId: "12", variantId: "120", productTitle: "Derby Shoe" }] }),
      ]),
    );
    expectCovers(await (await runRoute(orders, signedGet("/proxy/orders", domain, { customerId: "77" }))).json(), ORDERS);
    expectCovers(await (await runRoute(orders, signedGet("/proxy/orders", domain))).json(), ORDERS_LOGGED_OUT);
  });

  it("catalog_search (?q=…)", async () => {
    fakes = fakeStorefront({
      "products(first:": {
        products: {
          nodes: [
            { id: "gid://shopify/Product/10", title: "Aria Boot", featuredMedia: { preview: { image: { url: "https://cdn/10.jpg" } } },
              variants: { nodes: [
                { id: "gid://shopify/ProductVariant/100", title: "UK 7", sku: null, media: { nodes: [] } },
                { id: "gid://shopify/ProductVariant/101", title: "UK 8", sku: null, media: { nodes: [] } },
              ] } },
            { id: "gid://shopify/Product/11", title: "Aria Sandal", featuredMedia: null,
              variants: { nodes: [{ id: "gid://shopify/ProductVariant/110", title: "Default Title", sku: "SAN-1", media: { nodes: [] } }] } },
          ],
        },
      },
    });
    const body = await (await runRoute(catalogSearch, signedGet("/proxy/catalog_search", domain, { extra: { q: "aria" } }))).json();
    expectCovers(body, CATALOG);
  });

  it("order_lookup (FormData order_number + email; match and mismatch)", async () => {
    const { plan } = await buildCare(shop);
    fakes = fakeStorefront({
      "orders(first:": { orders: { nodes: [orderNode(9, { name: "#1042", email: "sarah@example.com", customerId: null, lines: [{ id: "55", quantity: 1 }] })] } },
    });
    await createItemFor(shop, { orderId: "9", orderLineId: "55", productId: "10", variantId: "100", productTitle: "Aria Boot", variantTitle: "UK 7", orderName: "#1042", purchasedAt: daysAgo(30) })
      .then((item) => createCover(careCoverFor(item, plan)));

    const found = await runRoute(orderLookup, signedPost("/proxy/order_lookup", domain, { order_number: "1042", email: "sarah@example.com" }));
    expectCovers(await found.json(), LOOKUP_FOUND);
    const miss = await runRoute(orderLookup, signedPost("/proxy/order_lookup", domain, { order_number: "1042", email: "wrong@example.com" }));
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual(LOOKUP_MISS);
  });

  it("intake (the request form's FormData; accepted and refused)", async () => {
    fakes = fakeStorefront();
    const form = {
      product_id: "10", variant_id: "100", product_title: "Aria Boot", variant_title: "UK 7", order_number: "#1042",
      order_date: "2026-09-01", no_order_history: "", item_id: "", order_id: "", order_line_id: "", order_token: "",
      unverified_purchase: "true", description: "Sole peeling", customer_name: "Sarah", customer_email: "sarah@example.com",
      customer_phone: "", "customer_address[address1]": "12 Bow Lane", "customer_address[address2]": "",
      "customer_address[city]": "London", "customer_address[zip]": "EC4M 9EU", "customer_address[country]": "United Kingdom",
    };
    const ok = await runRoute(intake, signedPost("/proxy/intake", domain, form));
    expect(ok.status).toBe(200);
    expectCovers(await ok.json(), INTAKE_OK);

    const refused = await runRoute(
      intake,
      signedPost("/proxy/intake", domain, { ...form, unverified_purchase: "", order_token: "signed-token", order_line_id: "55" }),
    );
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual(INTAKE_REFUSED);
  });

  it("status (repair_status block)", async () => {
    fakes = fakeStorefront();
    const { plan } = await buildCare(shop, { name: "18-month Care", termMonths: 18 });
    const item = await createItemFor(shop, { shopifyCustomerId: "77", purchasedAt: daysAgo(30) });
    const cover = await createCover(careCoverFor(item, plan));
    const quoted = await createRepairTicketFor(shop, { shopifyCustomerId: "77", productTitle: "Boot", status: "quoted", itemId: item.id, coverId: cover.id });
    const quote = await createQuotationFor(quoted.id, { status: "sent", subtotal: 24 });
    await issueDecisionToken(quote.id, new Date(Date.now() + 86_400_000));

    const body = (await (await runRoute(status, signedGet("/proxy/status", domain, { customerId: "77" }))).json()) as typeof STATUS;
    expectCovers(body, { ...STATUS, tickets: [STATUS.tickets[0]] });
  });

  it("status (repair_status block): a repair waiting for the item links its postage slip", async () => {
    fakes = fakeStorefront();
    shop = await prisma.shop.update({ where: { id: shop.id }, data: { settings: { currency: "GBP", ...WORKSHOP_SETTINGS } } });
    const awaiting = await createRepairTicketFor(shop, { shopifyCustomerId: "77", productTitle: "Loafer", status: "awaiting_item" });
    await createQuotationFor(awaiting.id, { status: "paid", subtotal: 30 });

    const body = (await (await runRoute(status, signedGet("/proxy/status", domain, { customerId: "77" }))).json()) as typeof STATUS;
    expectCovers(body, { ...STATUS, tickets: [STATUS.tickets[3]] });
  });

  it("care_offers (Add Care later)", async () => {
    fakes = fakeStorefront();
    const { plan } = await buildCare(shop);
    await createItemFor(shop, { shopifyCustomerId: "77", productTitle: "Aria Boot", purchasedAt: daysAgo(5), eligibleCarePlanIds: [plan.id] });

    const body = await (await runRoute(careOffers, signedGet("/proxy/care_offers", domain, { customerId: "77" }))).json();
    expectCovers(body, CARE_OFFERS);
  });
});

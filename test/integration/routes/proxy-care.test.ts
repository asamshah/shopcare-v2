/**
 * Port of the storefront half of Rails test/integration/care_plans_test.rb
 * ("storefront: plans for a product, and Care offers on past purchases"),
 * split per endpoint, plus the CDN caching rules.
 */
import type { CarePlan, Shop } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addDays, addMonths } from "../../../app/lib/dates";
import { updateCarePlan } from "../../../app/models/care-plan.server";
import { loader as carePlans } from "../../../app/routes/proxy.care_plans";
import { loader as careOffers } from "../../../app/routes/proxy.care_offers";
import { buildCare, createItemFor, createProductGroupFor, daysAgo } from "../../support/factories";
import {
  fakeStorefront,
  installedShop,
  runRoute,
  signedGet,
  type StorefrontFakes,
} from "../../support/proxy-routes";

const domain = "care-admin.myshopify.com";

const productNode = (tags: string[]) => ({
  product: { id: "gid://shopify/Product/10", title: "Aria Boot", productType: "Boots", tags, collections: { nodes: [] } },
});

describe("Care on the storefront (App Proxy)", () => {
  let shop: Shop;
  let plan: CarePlan;
  let fakes: StorefrontFakes;

  beforeEach(async () => {
    shop = await installedShop(domain, { settings: { currency: "GBP" } });
    ({ plan } = await buildCare(shop));
  });
  afterEach(() => fakes?.restore());

  it("plans for a product, filtered by the plan's product group, CDN-cacheable", async () => {
    const group = await createProductGroupFor(shop, { name: "Leather", rule: "tags", tags: ["leather"] });
    await updateCarePlan(plan.id, { productGroupId: group.id });
    fakes = fakeStorefront({ "product(id:": productNode(["Leather"]) });

    const response = await runRoute(
      carePlans,
      signedGet("/proxy/care_plans", domain, { extra: { product_id: "10", product_title: "Aria Boot" } }),
    );

    const body = (await response.json()) as { currency: string; plans: Record<string, never>[] };
    expect(body.currency).toBe("GBP");
    const plans = body.plans;
    expect(plans.map((p) => [p.name, p.variant_id, p.price])).toEqual([["2-year Care", "7001", "15.00"]]);
    expect(plans[0].exclusions).toContain("Accidental damage");
    expect((plans[0].terms as string[]).at(-1)).toBe(
      "This plan is in addition to, and does not affect, your statutory rights.",
    );
    expect((plans[0].terms as string[])[0]).toMatch(/^All repairs to your Aria Boot for 2 years, except: theft or loss;/);
    expect(plans[0].benefits).toEqual(["All repairs for 2 years"]);
    expect(plans[0].badge).toBe("ShopCare – 2 year plan");
    expect(Object.keys(plans[0])).toEqual([
      "id", "name", "badge", "variant_id", "price", "term_months", "benefits", "exclusions", "terms",
    ]);
    expect(response.headers.get("Netlify-Vary")).toBe("query=shop|product_id|product_title");
    expect(response.headers.get("Netlify-CDN-Cache-Control")).toContain("public");
  });

  it("no plans for a product outside the group, or one Shopify doesn't know", async () => {
    const group = await createProductGroupFor(shop, { name: "Leather", rule: "tags", tags: ["leather"] });
    await updateCarePlan(plan.id, { productGroupId: group.id });
    fakes = fakeStorefront({ "product(id:": productNode(["Canvas"]) });
    const get = (productId: string) =>
      runRoute(carePlans, signedGet("/proxy/care_plans", domain, { extra: { product_id: productId } }));

    expect(((await (await get("10")).json()) as { plans: unknown[] }).plans).toEqual([]);
    fakes.restore();
    fakes = fakeStorefront({ "product(id:": { product: null } });
    expect(((await (await get("11")).json()) as { plans: unknown[] }).plans).toEqual([]);
  });

  it("plans for every product need no Shopify call; no product id, no plans", async () => {
    fakes = fakeStorefront();
    const withProduct = await runRoute(carePlans, signedGet("/proxy/care_plans", domain, { extra: { product_id: "10" } }));
    const plans = ((await withProduct.json()) as { plans: { terms: string[] }[] }).plans;
    expect(plans).toHaveLength(1);
    expect(plans[0].terms[0]).toMatch(/^All repairs to your item for 2 years/);
    expect(fakes.api.calls).toHaveLength(0);

    const without = await runRoute(carePlans, signedGet("/proxy/care_plans", domain));
    expect(((await without.json()) as { plans: unknown[] }).plans).toEqual([]);
  });

  it("Care offers on a logged-in customer's past purchases", async () => {
    fakes = fakeStorefront();
    const item = await createItemFor(shop, {
      shopifyCustomerId: "77",
      productTitle: "Boot",
      purchasedAt: daysAgo(5),
      eligibleCarePlanIds: [plan.id],
    });
    await createItemFor(shop, { shopifyCustomerId: "77", productTitle: "Old", purchasedAt: daysAgo(90), eligibleCarePlanIds: [plan.id] });

    const response = await runRoute(careOffers, signedGet("/proxy/care_offers", domain, { customerId: "77" }));

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await response.json()) as { logged_in: boolean; currency: string; items: Record<string, never>[] };
    expect([body.logged_in, body.currency]).toEqual([true, "GBP"]);
    expect(body.items.map((o) => o.item_id)).toEqual([item.id]);
    const offer = body.items[0] as unknown as { plans: { offer_ends: string; terms: string[] }[] } & Record<string, unknown>;
    expect(Object.keys(offer)).toEqual(["item_id", "product_title", "order_name", "purchased_at", "plans"]);
    expect(offer.order_name).toBeNull();
    expect(offer.plans[0].offer_ends).toBe(addDays(item.purchasedAt!, 30).toISOString().slice(0, 10));
    // Care added later runs from the purchase date (the order confirmation's Care section shows it).
    expect((offer.plans[0] as unknown as { cover_ends: string }).cover_ends).toBe(
      addMonths(item.purchasedAt!, 24).toISOString().slice(0, 10),
    );
    expect(offer.plans[0].terms[0]).toContain("All repairs to your Boot for 2 years");
  });

  it("a browser-supplied customer_id is not a login", async () => {
    fakes = fakeStorefront();
    await createItemFor(shop, { shopifyCustomerId: "77", purchasedAt: daysAgo(5), eligibleCarePlanIds: [plan.id] });

    const response = await runRoute(careOffers, signedGet("/proxy/care_offers", domain, { extra: { customer_id: "77" } }));

    expect(await response.json()).toEqual({ ok: true, logged_in: false, items: [] });
  });
});

/**
 * The daily "Add Care" offer: due N days after purchase (care_offer_delay_days,
 * default 7), one per order, emitted through the Prisma notification store.
 * ShopCare never emails it: the optional Flow trigger, and the customer tag
 * merchants can target from Shopify Email.
 */
import { describe, expect, it, vi } from "vitest";
import type { Shop } from "@prisma/client";
import prisma from "../../../app/db.server";
import { emitCareOffers } from "../../../app/jobs/care-offers.server";
import { careOfferWindow, dueCareOffers } from "../../../app/services/care/care-offers.server";
import { PrismaNotificationStore } from "../../../app/services/notifications/prisma-store.server";
import { createCarePlanFor, createItemFor, createShop } from "../../support/factories";
import { FakeGraphql } from "../../support/fake-graphql";
import { careOfferEligibleCustomers } from "../../../app/services/care/care-offer-tags.server";
import { careCoverFor, createCover } from "../../../app/models/cover.server";

const now = new Date("2026-10-16T10:00:00Z");
const daysBefore = (n: number) => new Date(now.getTime() - n * 86_400_000);

async function shopWithPlan(notifications: Record<string, unknown> = {}) {
  const shop = await createShop({
    settings: {
      care: { add_later_url: "https://acme.example/pages/care" },
      notifications: { flow: true, ...notifications },
    },
  });
  const plan = await createCarePlanFor(shop, { name: "2-year Care", price: 15, offerWindowDays: 30 });
  return { shop, plan };
}

const orderItem = (shop: Shop, planId: number, overrides: Record<string, unknown> = {}) =>
  createItemFor(shop, {
    orderId: "5001",
    orderLineId: `${Math.random()}`,
    shopifyCustomerId: "77",
    customerEmail: "a@example.com",
    customerName: "Sarah",
    purchasedAt: daysBefore(7),
    eligibleCarePlanIds: [planId],
    ...overrides,
  });

const currency = async () => "GBP";

describe("dueCareOffers", () => {
  it("offers Care for an order bought delay days ago, one offer per order", async () => {
    const { shop, plan } = await shopWithPlan();
    await orderItem(shop, plan.id, { productTitle: "Aria Boot" });
    await orderItem(shop, plan.id, { productTitle: "Chelsea Boot" });

    const offers = await dueCareOffers(shop, { now, currency });
    expect(offers).toEqual([
      {
        recipient: { customerId: "77", email: "a@example.com", name: "Sarah" },
        data: {
          orderId: "5001",
          productTitle: "Aria Boot and Chelsea Boot",
          carePlan: "2-year Care",
          carePrice: 15,
          currency: "GBP",
          offerEnds: daysBefore(7 - 30).toISOString().slice(0, 10),
          addCareUrl: "https://acme.example/pages/care",
          customerName: "Sarah",
        },
      },
    ]);
  });

  it("waits until the delay has passed and catches up a missed day or two", async () => {
    const { shop, plan } = await shopWithPlan();
    await orderItem(shop, plan.id, { orderId: "1", purchasedAt: daysBefore(6) });
    await orderItem(shop, plan.id, { orderId: "2", purchasedAt: daysBefore(8) });
    await orderItem(shop, plan.id, { orderId: "3", purchasedAt: daysBefore(10) });

    const offers = await dueCareOffers(shop, { now, currency });
    expect(offers.map((o) => o.data.orderId)).toEqual(["2"]);
  });

  it("uses the shop's care_offer_delay_days", async () => {
    const { shop, plan } = await shopWithPlan({ care_offer_delay_days: 3 });
    await orderItem(shop, plan.id, { purchasedAt: daysBefore(3) });
    expect(careOfferWindow(shop, now).to).toEqual(daysBefore(3));
    expect(await dueCareOffers(shop, { now, currency })).toHaveLength(1);
  });

  it("skips items not eligible, refunded, registered, or past the offer window, and asks no currency then", async () => {
    const { shop, plan } = await shopWithPlan();
    await orderItem(shop, plan.id, { eligibleCarePlanIds: [] });
    await orderItem(shop, plan.id, { orderId: "2", status: "refunded" });
    await orderItem(shop, plan.id, { orderId: "3", source: "registration" });
    const short = await createCarePlanFor(shop, { offerWindowDays: 5 });
    await orderItem(shop, short.id, { orderId: "4", eligibleCarePlanIds: [short.id] });

    const ask = vi.fn(currency);
    expect(await dueCareOffers(shop, { now, currency: ask })).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("emitCareOffers (the care-offers job)", () => {
  it("claims one care_offer delivery per order, once, for installed shops only", async () => {
    const { shop, plan } = await shopWithPlan();
    await orderItem(shop, plan.id);
    const gone = await shopWithPlan();
    await prisma.shop.update({ where: { id: gone.shop.id }, data: { uninstalledAt: now } });
    await orderItem(gone.shop, gone.plan.id);

    const enqueue = vi.fn(async () => {});
    const deps = { store: new PrismaNotificationStore(prisma), enqueue };
    expect(await emitCareOffers({ now, deps, currency, tagClient: false })).toEqual({
      emitted: 1,
      tagged: 0,
      untagged: 0,
      failed: [],
    });
    await emitCareOffers({ now, deps, currency, tagClient: false });

    const rows = await prisma.notificationDelivery.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shopId: shop.id,
      event: "care_offer",
      channel: "flow",
      idempotencyKey: "care_offer:order_5001",
      status: "pending",
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("emits nothing while Flow is off and Klaviyo isn't connected", async () => {
    const shop = await createShop();
    const plan = await createCarePlanFor(shop, { offerWindowDays: 30 });
    await orderItem(shop, plan.id);
    const deps = { store: new PrismaNotificationStore(prisma), enqueue: vi.fn(async () => {}) };
    await emitCareOffers({ now, deps, currency, tagClient: false });
    expect(await prisma.notificationDelivery.count()).toBe(0);
  });

  it("carries on past a failing shop and reports it", async () => {
    const { shop, plan } = await shopWithPlan();
    await orderItem(shop, plan.id);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = { store: new PrismaNotificationStore(prisma), enqueue: vi.fn(async () => {}) };
    const result = await emitCareOffers({
      now,
      deps,
      currency: async () => {
        throw new Error("Shopify down");
      },
      tagClient: false,
    });
    error.mockRestore();
    expect(result).toEqual({ emitted: 0, tagged: 0, untagged: 0, failed: [shop.shopifyDomain] });
  });
});

describe("the shopcare-care-offer-eligible customer tag (no Flow needed)", () => {
  const tagApi = (alreadyTagged: string[]) =>
    new FakeGraphql({
      "customers(": (vars: Record<string, unknown>) => {
        expect(vars.query).toBe("tag:'shopcare-care-offer-eligible'");
        return {
          customers: {
            nodes: alreadyTagged.map((id) => ({ id: `gid://shopify/Customer/${id}` })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      },
      "tagsAdd(": { tagsAdd: { node: { id: "x" }, userErrors: [] } },
      "tagsRemove(": { tagsRemove: { node: { id: "x" }, userErrors: [] } },
    });
  const calls = (api: FakeGraphql, fragment: string) =>
    api.calls.filter((c) => c.query.includes(fragment)).map((c) => [c.variables.id, c.variables.tags]);

  it("tags customers still able to add Care and untags the rest, with Flow off", async () => {
    const shop = await createShop({ settings: { care: { add_later_url: "https://acme.example/pages/care" } } });
    const plan = await createCarePlanFor(shop, { offerWindowDays: 30 });
    await orderItem(shop, plan.id, { shopifyCustomerId: "77" }); // 7 days ago: eligible
    await orderItem(shop, plan.id, { orderId: "5002", orderLineId: "2", shopifyCustomerId: "78", purchasedAt: daysBefore(3) }); // too soon
    await orderItem(shop, plan.id, { orderId: "5003", orderLineId: "3", shopifyCustomerId: "79", purchasedAt: daysBefore(31) }); // window over
    await orderItem(shop, plan.id, { orderId: "5004", orderLineId: "4", shopifyCustomerId: null, customerEmail: "g@x.y" }); // guest
    const api = tagApi(["79", "80"]);
    const deps = { store: new PrismaNotificationStore(prisma), enqueue: vi.fn(async () => {}) };

    const result = await emitCareOffers({ now, deps, currency, tagClient: async () => api });
    expect(result).toMatchObject({ emitted: 2, tagged: 1, untagged: 2, failed: [] }); // 2 offers due (77 and the guest)
    expect(calls(api, "tagsAdd(")).toEqual([["gid://shopify/Customer/77", ["shopcare-care-offer-eligible"]]]);
    expect(calls(api, "tagsRemove(")).toEqual([
      ["gid://shopify/Customer/79", ["shopcare-care-offer-eligible"]],
      ["gid://shopify/Customer/80", ["shopcare-care-offer-eligible"]],
    ]);
    expect(await prisma.notificationDelivery.count()).toBe(0); // Flow off: no trigger
  });

  it("buying Care ends eligibility; a shop without Care plans is left alone", async () => {
    const shop = await createShop();
    const plan = await createCarePlanFor(shop, { offerWindowDays: 30 });
    const item = await orderItem(shop, plan.id, { shopifyCustomerId: "77" });
    expect([...(await careOfferEligibleCustomers(shop, { now }))]).toEqual(["77"]);
    await createCover(careCoverFor(item, plan, { now }));
    expect([...(await careOfferEligibleCustomers(shop, { now }))]).toEqual([]);

    const noCare = await createShop();
    const api = tagApi([]);
    await emitCareOffers({ now, deps: { store: new PrismaNotificationStore(prisma), enqueue: vi.fn(async () => {}) }, currency, tagClient: async () => api });
    expect(api.calls.filter((c) => c.variables.query)).toHaveLength(1); // only the shop with a plan
    expect(noCare).toBeTruthy();
  });
});

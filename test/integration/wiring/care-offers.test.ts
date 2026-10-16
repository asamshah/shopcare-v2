/**
 * The daily "Add Care" offer: due N days after purchase (care_offer_delay_days,
 * default 7), one per order, emitted through the Prisma notification store.
 * Consent is checked later, when the delivery is sent.
 */
import { describe, expect, it, vi } from "vitest";
import type { Shop } from "@prisma/client";
import prisma from "../../../app/db.server";
import { emitCareOffers } from "../../../app/jobs/care-offers.server";
import { careOfferWindow, dueCareOffers } from "../../../app/services/care/care-offers.server";
import { PrismaNotificationStore } from "../../../app/services/notifications/prisma-store.server";
import { createCarePlanFor, createItemFor, createShop } from "../../support/factories";

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
    expect(await emitCareOffers({ now, deps, currency })).toEqual({ emitted: 1, failed: [] });
    await emitCareOffers({ now, deps, currency });

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
    await emitCareOffers({ now, deps, currency });
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
    });
    error.mockRestore();
    expect(result).toEqual({ emitted: 0, failed: [shop.shopifyDomain] });
  });
});

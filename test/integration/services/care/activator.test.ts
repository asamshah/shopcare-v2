/** Port of Rails test/services/care/activator_test.rb. */
import type { CarePlan, Shop } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../../../app/db.server";
import { addMonths } from "../../../../app/lib/dates";
import { CareActivator } from "../../../../app/services/care/activator.server";
import { ItemRecorder } from "../../../../app/services/items/recorder.server";
import { buildCare, createItemFor, createShop, daysAgo } from "../../../support/factories";
import { orderData, orderLine } from "../../../support/orders";

const careLine = (overrides: Parameters<typeof orderLine>[0] = {}) =>
  orderLine({ id: "2", productId: "700", variantId: "7001", title: "2-year Care", unitPrice: "15.00", ...overrides });

describe("CareActivator", () => {
  let shop: Shop;
  let plan: CarePlan;

  beforeEach(async () => {
    shop = await createShop({ shopifyDomain: "activator-test.myshopify.com" });
    plan = (await buildCare(shop)).plan;
  });

  it("a Care line bought with a product becomes Care on that item, not an item itself", async () => {
    const recorder = new ItemRecorder(shop);
    const items = await recorder.record(orderData({ lines: [orderLine(), careLine()] }));

    expect(items.map((i) => i.productTitle)).toEqual(["Aria Boot"]);
    const cover = recorder.careResult.covers[0];
    expect(cover).toMatchObject({
      itemId: items[0].id,
      kind: "care",
      carePlanId: plan.id,
      shopifyOrderId: "500",
      shopifyLineItemId: "2",
      lineUnitIndex: 0,
    });
    expect(Number(cover.pricePaid)).toBe(15);
    expect(cover.endsAt).toEqual(addMonths(items[0].purchasedAt!, 24));
  });

  it("is idempotent and covers one unit per Care unit", async () => {
    const order = orderData({ lines: [orderLine({ quantity: 2 }), careLine({ quantity: 2 })] });
    await new ItemRecorder(shop).record(order);
    await new ItemRecorder(shop).record(order);

    const covers = await prisma.cover.findMany({ where: { kind: "care" } });
    expect(covers).toHaveLength(2);
    expect(new Set(covers.map((c) => c.itemId)).size).toBe(2);
  });

  it("one cover per Care unit, even when runs race", async () => {
    const order = orderData({ lines: [orderLine({ quantity: 2 }), careLine({ quantity: 2 })] });
    await new ItemRecorder(shop).record(order);
    // Both activators run at once over the recorded items.
    await prisma.cover.deleteMany({ where: { kind: "care" } });
    const results = await Promise.all([
      new CareActivator(shop).activate(order),
      new CareActivator(shop).activate(order),
    ]);
    expect(await prisma.cover.count({ where: { kind: "care" } })).toBe(2);
    expect(results.flatMap((r) => r.unmatched)).toEqual([]);
  });

  it("Care added later attaches to the customer's item within the offer window", async () => {
    const item = await createItemFor(shop, {
      shopifyCustomerId: "77",
      productTitle: "Boot",
      purchasedAt: daysAgo(10),
      eligibleCarePlanIds: [plan.id],
    });
    const line = careLine({ properties: { _shopcare_item: String(item.id) } });

    const result = await new CareActivator(shop).activate(orderData({ id: "600", lines: [line] }));

    expect(result.covers.map((c) => c.itemId)).toEqual([item.id]);
  });

  it("Care added later is refused for someone else's item or after the window", async () => {
    const theirs = await createItemFor(shop, {
      shopifyCustomerId: "99",
      purchasedAt: daysAgo(1),
      eligibleCarePlanIds: [plan.id],
    });
    const old = await createItemFor(shop, {
      shopifyCustomerId: "77",
      purchasedAt: daysAgo(90),
      eligibleCarePlanIds: [plan.id],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const item of [theirs, old]) {
      const result = await new CareActivator(shop).activate(
        orderData({ lines: [careLine({ properties: { _shopcare_item: String(item.id) } })] }),
      );
      expect(result.covers).toEqual([]);
      expect(result.unmatched).toHaveLength(1);
    }
    warn.mockRestore();
  });
});

/** Port of Rails test/services/items/recorder_test.rb. */
import type { Shop } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import prisma from "../../../../app/db.server";
import { activeCover, findItemWithCovers } from "../../../../app/models/item.server";
import { ItemRecorder } from "../../../../app/services/items/recorder.server";
import { CoverAssigner } from "../../../../app/services/warranty/cover-assigner.server";
import { createProductGroupFor, createShop, createWarrantyPolicyFor } from "../../../support/factories";
import { orderData, orderLine } from "../../../support/orders";

describe("ItemRecorder", () => {
  let shop: Shop;

  beforeEach(async () => {
    shop = await createShop({ shopifyDomain: "rec-test.myshopify.com", settings: { repair_order_tag: "Repair" } });
    await createWarrantyPolicyFor(shop, { name: "12-month warranty", months: 12 });
  });

  it("creates one item per unit, each with warranty cover", async () => {
    const items = await new ItemRecorder(shop).record(orderData({ lines: [orderLine({ quantity: 2 })] }));

    expect(items.map((i) => i.unitIndex)).toEqual([0, 1]);
    for (const item of items) {
      expect(activeCover(await findItemWithCovers(item.id))?.terms).toMatchObject({ name: "12-month warranty" });
    }
    expect(items[0]).toMatchObject({ shopifyCustomerId: "77", orderId: "500", orderLineId: "1", source: "order" });
    expect(items[0].unitPrice?.toFixed(2)).toBe("50.00");
  });

  it("is idempotent", async () => {
    const recorder = new ItemRecorder(shop);
    await recorder.record(orderData());

    expect(await recorder.record(orderData())).toEqual([]);
    expect(await prisma.item.count()).toBe(1);
    expect(await prisma.cover.count()).toBe(1);
  });

  it("concurrent recordings of the same order create each unit once", async () => {
    const order = orderData({ lines: [orderLine({ quantity: 3 })] });
    await Promise.all([new ItemRecorder(shop).record(order), new ItemRecorder(shop).record(order)]);
    expect(await prisma.item.count()).toBe(3);
  });

  it("skips repair orders, gift cards, unshipped lines and custom lines", async () => {
    expect(await new ItemRecorder(shop).record(orderData({ tags: ["repair"] }))).toEqual([]);

    const lines = [
      orderLine({ id: "2", giftCard: true }),
      orderLine({ id: "3", requiresShipping: false }),
      orderLine({ id: "4", productId: null }),
    ];
    expect(await new ItemRecorder(shop).record(orderData({ lines }))).toEqual([]);
    expect(await new ItemRecorder(shop).record(orderData({ customerId: null, email: null }))).toEqual([]);
  });

  it("caps units per line", async () => {
    const items = await new ItemRecorder(shop).record(orderData({ lines: [orderLine({ quantity: 50 })] }));
    expect(items).toHaveLength(20);
  });

  it("items with no matching policy get no cover", async () => {
    const group = await createProductGroupFor(shop, { name: "Leather", rule: "tags", tags: ["leather"] });
    await prisma.warrantyPolicy.updateMany({ data: { productGroupId: group.id } });
    const facts = {
      fetch: async (id: string | null | undefined) => ({ productId: id ?? null, tags: ["suede"], collectionIds: [] }),
    };

    const items = await new ItemRecorder(shop, { coverAssigner: new CoverAssigner(shop, facts) }).record(orderData());

    expect(items).toHaveLength(1);
    expect(activeCover(await findItemWithCovers(items[0].id))).toBeNull();
  });
});

/** Port of Rails test/services/items/refund_processor_test.rb. */
import type { CarePlan, Cover, Item, Shop } from "@prisma/client";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import prisma from "../../../../app/db.server";
import { careCoverFor, createCover, warrantyCoverFor } from "../../../../app/models/cover.server";
import { processRefund, type CareHandler, type RefundWebhookBody } from "../../../../app/services/items/refund-processor.server";
import { buildCare, createItemFor, createShop, createWarrantyPolicyFor, daysAgo } from "../../../support/factories";

// Lets a test fail, or race, the processor while it holds an item's lock.
const lockHook = vi.hoisted(() => ({ onItemLock: null as null | ((tx: unknown, id: number) => Promise<void>) }));
vi.mock("../../../../app/lib/db-lock.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../app/lib/db-lock.server")>();
  return {
    ...original,
    withRowLock: async (tx: Parameters<typeof original.withRowLock>[0], table: string, id: number) => {
      await original.withRowLock(tx, table, id);
      if (table === "items" && lockHook.onItemLock) await lockHook.onItemLock(tx, id);
    },
  };
});

describe("processRefund", () => {
  beforeEach(() => {
    lockHook.onItemLock = null;
  });

  it("marks refunded units and cancels their cover, highest unit first", async () => {
    const shop = await createShop({ shopifyDomain: "ref-test.myshopify.com" });
    const policy = await createWarrantyPolicyFor(shop, { name: "W", months: 12 });
    const items: Item[] = [];
    for (const unitIndex of [0, 1]) {
      const item = await createItemFor(shop, { productTitle: "Boot", orderLineId: "9", unitIndex, purchasedAt: daysAgo(1) });
      await createCover(warrantyCoverFor(item, policy));
      items.push(item);
    }

    const count = await processRefund(shop, { order_id: 1, refund_line_items: [{ line_item_id: 9, quantity: 1 }] }, { careHandler: vi.fn<CareHandler>(async () => {}) });

    expect(count).toBe(1);
    const [first, last] = await Promise.all(items.map((i) => prisma.item.findUniqueOrThrow({ where: { id: i.id }, include: { covers: true } })));
    expect(first.status).toBe("active");
    expect(last.status).toBe("refunded");
    expect(last.covers.every((c) => c.status === "cancelled")).toBe(true);
  });

  describe("with Care", () => {
    let shop: Shop;
    let plan: CarePlan;
    let items: Item[];
    let covers: Cover[];
    let handler: Mock<CareHandler>;

    const refund = (lines: RefundWebhookBody["refund_line_items"], id?: number) =>
      processRefund(shop, { ...(id ? { id } : {}), order_id: 500, refund_line_items: lines }, { careHandler: handler });
    const status = async (cover: Cover) => (await prisma.cover.findUniqueOrThrow({ where: { id: cover.id } })).status;
    const itemStatus = async (item: Item) => (await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).status;

    beforeEach(async () => {
      shop = await createShop({ shopifyDomain: "ref-care.myshopify.com" });
      plan = (await buildCare(shop)).plan;
      items = [];
      covers = [];
      for (const unitIndex of [0, 1]) {
        const item = await createItemFor(shop, { productTitle: "Boot", orderId: "500", orderLineId: "1", unitIndex, purchasedAt: daysAgo(1) });
        items.push(item);
        covers.push(await createCover(careCoverFor(item, plan, { orderId: "500", lineItemId: "2", pricePaid: 15 })));
      }
      handler = vi.fn<CareHandler>(async () => {});
    });

    it("a refund delivered twice (retried or late) is applied once", async () => {
      await refund([{ line_item_id: 2, quantity: 1 }], 3001);
      await refund([{ line_item_id: 2, quantity: 1 }], 3001);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(covers[1].id, ["2"]);
      expect(await status(covers[0])).toBe("active");
      expect(await status(covers[1])).toBe("cancelled");
      expect((await prisma.processedRefund.findMany()).map((r) => r.refundId)).toEqual(["3001"]);
    });

    it("concurrent deliveries of one refund apply it once", async () => {
      await Promise.all([refund([{ line_item_id: 2, quantity: 1 }], 3005), refund([{ line_item_id: 2, quantity: 1 }], 3005)]);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(await prisma.cover.count({ where: { status: "cancelled" } })).toBe(1);
    });

    it("two distinct partial refunds of one unit each cancel two plans", async () => {
      await refund([{ line_item_id: 2, quantity: 1 }], 3001);
      await refund([{ line_item_id: 2, quantity: 1 }], 3002);
      await refund([{ line_item_id: 2, quantity: 1 }], 3002);
      expect(handler).toHaveBeenCalledTimes(2);
      expect([await status(covers[0]), await status(covers[1])]).toEqual(["cancelled", "cancelled"]);
    });

    it("a duplicate item refund doesn't refund the next unit", async () => {
      expect([await refund([{ line_item_id: 1, quantity: 1 }], 3003), await refund([{ line_item_id: 1, quantity: 1 }], 3003)]).toEqual([1, 0]);
      expect(handler).toHaveBeenCalledTimes(1);
      expect([await itemStatus(items[0]), await itemStatus(items[1])]).toEqual(["active", "refunded"]);
    });

    it("a delivery that fails part-way rolls back, so the retry applies it", async () => {
      lockHook.onItemLock = async () => {
        throw new Error("boom");
      };
      await expect(refund([{ line_item_id: 1, quantity: 1 }], 3004)).rejects.toThrow("boom");
      expect(await itemStatus(items[1])).toBe("active");
      expect(await prisma.processedRefund.count()).toBe(0);

      lockHook.onItemLock = null;
      expect(await refund([{ line_item_id: 1, quantity: 1 }], 3004)).toBe(1);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("a Care-only refund cancels that many Care covers on the line, items untouched", async () => {
      expect(await refund([{ line_item_id: 2, quantity: 1 }])).toBe(0);
      expect(handler).toHaveBeenCalledWith(covers[1].id, ["2"]);
      expect([await status(covers[0]), await status(covers[1])]).toEqual(["active", "cancelled"]);
      expect([await itemStatus(items[0]), await itemStatus(items[1])]).toEqual(["active", "active"]);
    });

    it("an item refunded with its Care line has its Care handled once", async () => {
      expect(await refund([{ line_item_id: 1, quantity: 1 }, { line_item_id: 2, quantity: 1 }])).toBe(1);
      expect(handler).toHaveBeenCalledTimes(1);
      expect([await status(covers[0]), await status(covers[1])]).toEqual(["active", "cancelled"]);
    });

    it("skips items a concurrent delivery already refunded", async () => {
      lockHook.onItemLock = async (tx, id) => {
        await (tx as typeof prisma).item.update({ where: { id }, data: { status: "refunded" } });
      };
      expect(await refund([{ line_item_id: 1, quantity: 1 }])).toBe(0);
      expect(handler).not.toHaveBeenCalled();
      expect(await status(covers[1])).toBe("active");
    });

    it("reads line item ids from their GIDs when present", async () => {
      expect(
        await processRefund(
          shop,
          { refund_line_items: [{ line_item_id: 0, quantity: 1, line_item: { admin_graphql_api_id: "gid://shopify/LineItem/1" } }] },
          { careHandler: handler },
        ),
      ).toBe(1);
    });


  });
});

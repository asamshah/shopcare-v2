/**
 * Port of the order-lookup half of Rails
 * test/services/repairs/order_lookup_and_catalog_test.rb (the catalogue half
 * and number normalising are in test/unit/shopify/{products,orders}.test.ts).
 */
import type { Shop } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import prisma from "../../../../app/db.server";
import { ItemRecorder } from "../../../../app/services/items/recorder.server";
import {
  lookUpOrder,
  orderToken,
  verifiedOrderId,
} from "../../../../app/services/repairs/order-lookup.server";
import { createShop } from "../../../support/factories";
import { FakeGraphql } from "../../../support/fake-graphql";
import { orderNode } from "../../../support/orders";

describe("order lookup", () => {
  let shop: Shop;
  let api: FakeGraphql;

  beforeEach(async () => {
    shop = await createShop({ shopifyDomain: "lookup-test.myshopify.com" });
  });

  const node = (options: Parameters<typeof orderNode>[1] = {}) =>
    orderNode(9, {
      name: "#1042",
      email: "Sarah@Example.com",
      lines: [{ id: "55", quantity: 2, imageUrl: "https://cdn/aria.jpg" }],
      ...options,
    });
  const find = (who: { customerId?: string | null; email?: string | null }, number = "1042", n = node()) => {
    api = new FakeGraphql({ "orders(first:": { orders: { nodes: [n] } } });
    return lookUpOrder(shop, api, new ItemRecorder(shop), number, who, { logger: { error: () => {} } });
  };

  it("a guest finds the order with its number and email (any case), one card per line", async () => {
    const result = await find({ email: " sarah@example.COM " });

    expect(result!.order.name).toBe("#1042");
    expect(result!.items.map((i) => i.orderLineId)).toEqual(["55"]);
    expect(result!.images["55"]).toBe("https://cdn/aria.jpg");
    expect(api.calls[0].variables.q).toBe("name:1042");
    expect(await prisma.item.count({ where: { orderId: "9" } })).toBe(2);
  });

  it("a wrong email, a missing email or another order's number finds nothing", async () => {
    expect(await find({ email: "someone@example.com" }, "#1042")).toBeNull();
    expect(await find({ email: "" }, "#1042")).toBeNull();
    expect(await find({ email: "sarah@example.com" }, "#104")).toBeNull();
    expect(await prisma.item.count()).toBe(0);
  });

  it("a logged-in customer only finds their own orders", async () => {
    expect(await find({ customerId: "77" })).not.toBeNull();
    expect(await find({ customerId: "88" })).toBeNull();
    expect(await find({ customerId: "77" }, "1042", node({ customerId: null }))).toBeNull();
  });

  it("the order token names its order, for this shop only, until it expires", async () => {
    const now = new Date("2026-10-16T12:00:00Z");
    const token = orderToken(shop, "9", now);

    expect(verifiedOrderId(shop, token, now)).toBe("9");
    const other = await createShop({ shopifyDomain: "x.myshopify.com" });
    expect(verifiedOrderId(other, token, now)).toBeNull();
    expect(verifiedOrderId(shop, token, new Date(now.getTime() + 3 * 3600_000))).toBeNull();
    expect(verifiedOrderId(shop, `${token}x`, now)).toBeNull();
    expect(verifiedOrderId(shop, token.replace(/^./, "A"), now)).toBeNull();
    expect(verifiedOrderId(shop, null, now)).toBeNull();
  });
});

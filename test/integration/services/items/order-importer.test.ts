/** Port of Rails test/services/items/order_importer_test.rb. */
import type { Shop } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import prisma from "../../../../app/db.server";
import { OrderImporter } from "../../../../app/services/items/order-importer.server";
import { ItemRecorder } from "../../../../app/services/items/recorder.server";
import { createShop } from "../../../support/factories";
import { FakeGraphql } from "../../../support/fake-graphql";
import { orderNode } from "../../../support/orders";

describe("OrderImporter", () => {
  let shop: Shop;
  beforeEach(async () => {
    shop = await createShop({ shopifyDomain: "imp-test.myshopify.com" });
  });
  const importer = (api: FakeGraphql) => new OrderImporter(shop, api, new ItemRecorder(shop));

  it("imports one order for its own customer", async () => {
    const api = new FakeGraphql({ "order(id:": { order: orderNode(5) } });
    const items = await importer(api).importOrder("5", "77");
    expect(items.map((i) => i.orderLineId)).toEqual(["51"]);
  });

  it("refuses an order that belongs to someone else", async () => {
    const api = new FakeGraphql({ "order(id:": { order: orderNode(5, { customerId: "99" }) } });
    expect(await importer(api).importOrder("5", "77")).toEqual([]);
    expect(await prisma.item.count()).toBe(0);
  });

  it("imports recent paid orders page by page", async () => {
    const pages = [
      { orders: { nodes: [orderNode(1)], pageInfo: { hasNextPage: true, endCursor: "c1" } } },
      { orders: { nodes: [orderNode(2)], pageInfo: { hasNextPage: false, endCursor: null } } },
    ];
    const api = new FakeGraphql({ "orders(first:": () => pages.shift() });

    expect(await importer(api).importRecent()).toBe(2);
    expect(api.calls.at(-1)!.variables.after).toBe("c1");
    expect(api.calls[0].variables.q).toContain("financial_status:paid");
  });
});

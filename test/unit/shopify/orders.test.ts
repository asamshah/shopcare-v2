/**
 * Ported from Rails test/services/items/order_data_test.rb,
 * items/order_importer_test.rb, repairs/purchase_history_test.rb and the
 * order-lookup half of repairs/order_lookup_and_catalog_test.rb. Recording
 * Items and the guest order token belong to the domain services' tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  fetchCustomerOrder,
  fetchPurchaseHistory,
  fetchRecentPaidOrders,
  findOrderByNumber,
  normaliseOrderNumber,
  orderFromGraphql,
  orderFromWebhook,
  type OrderData,
  type OrderNode,
} from "../../../app/shopify/orders.server";
import { FakeGraphql } from "../../support/fake-graphql";

const quiet = { error: vi.fn() };

function orderNode(
  id: number | string,
  overrides: Partial<OrderNode> & { customerId?: string | null } = {},
): OrderNode {
  const { customerId = "77", ...rest } = overrides;
  return {
    id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    processedAt: "2026-09-01T00:00:00Z",
    createdAt: null,
    email: "a@example.com",
    tags: [],
    customer: customerId
      ? {
          id: `gid://shopify/Customer/${customerId}`,
          displayName: "Sarah",
          defaultEmailAddress: null,
        }
      : null,
    lineItems: {
      nodes: [
        {
          id: `gid://shopify/LineItem/${id}1`,
          title: "Boot",
          variantTitle: null,
          sku: null,
          quantity: 1,
          requiresShipping: true,
          isGiftCard: false,
          customAttributes: [],
          discountedUnitPriceAfterAllDiscountsSet: null,
          image: null,
          product: { id: "gid://shopify/Product/1" },
          variant: { id: "gid://shopify/ProductVariant/2" },
        },
      ],
    },
    ...rest,
  };
}

describe("order data", () => {
  it("normalises an orders/paid webhook body", () => {
    const order = orderFromWebhook({
      id: "820982911946154508",
      name: "#1042",
      processed_at: "2026-10-01T10:00:00Z",
      email: "a@example.com",
      tags: "VIP, Repair",
      customer: {
        id: "115310627314723954",
        first_name: "Sarah",
        last_name: "J",
      },
      line_items: [
        {
          id: 1,
          product_id: 10,
          variant_id: 100,
          title: "Aria Boot",
          variant_title: "UK 7",
          quantity: 2,
          requires_shipping: true,
          gift_card: false,
          sku: "AR-7",
          price: "50.00",
          total_discount: "10.00",
          properties: [{ name: "Engraving", value: "SJ" }],
        },
      ],
    });

    expect(order.id).toBe("820982911946154508");
    expect(order.customerId).toBe("115310627314723954");
    expect(order.customerName).toBe("Sarah J");
    expect(order.tags).toEqual(["vip", "repair"]);
    const line = order.lines[0];
    expect([
      line.id,
      line.productId,
      line.variantId,
      line.quantity,
      line.sku,
    ]).toEqual(["1", "10", "100", 2, "AR-7"]);
    expect(line.unitPrice).toBe("45.00");
    expect(line.properties).toEqual({ Engraving: "SJ" });
  });

  it("normalises a GraphQL order node", () => {
    const node = orderNode(5, {
      email: null,
      tags: ["Wholesale"],
      customer: {
        id: "gid://shopify/Customer/7",
        displayName: "Mike Chen",
        defaultEmailAddress: { emailAddress: "m@example.com" },
      },
    });
    node.lineItems.nodes[0] = {
      ...node.lineItems.nodes[0],
      id: "gid://shopify/LineItem/9",
      sku: "",
      product: { id: "gid://shopify/Product/3" },
      variant: { id: "gid://shopify/ProductVariant/4" },
      discountedUnitPriceAfterAllDiscountsSet: {
        shopMoney: { amount: "80.0" },
      },
    };

    const order = orderFromGraphql(node);

    expect([order.id, order.customerId, order.email, order.tags]).toEqual([
      "5",
      "7",
      "m@example.com",
      ["wholesale"],
    ]);
    const line = order.lines[0];
    expect([
      line.id,
      line.productId,
      line.variantId,
      line.sku,
      line.unitPrice,
    ]).toEqual(["9", "3", "4", null, "80.0"]);
  });
});

describe("order import", () => {
  it("fetches one order for its own customer", async () => {
    const api = new FakeGraphql({ "order(id:": { order: orderNode(5) } });

    const order = await fetchCustomerOrder(api, "5", "77");

    expect(order?.lines.map((l) => l.id)).toEqual(["51"]);
    expect(api.calls[0].variables.id).toBe("gid://shopify/Order/5");
  });

  it("refuses an order that belongs to someone else, or no customer", async () => {
    const api = new FakeGraphql({
      "order(id:": { order: orderNode(5, { customerId: "99" }) },
    });

    expect(await fetchCustomerOrder(api, "5", "77")).toBeNull();
    expect(await fetchCustomerOrder(api, "5", null)).toBeNull();
    expect(api.calls).toHaveLength(1);
  });

  it("fetches recent paid orders page by page", async () => {
    const pages = [
      {
        orders: {
          nodes: [orderNode(1)],
          pageInfo: { hasNextPage: true, endCursor: "c1" },
        },
      },
      {
        orders: {
          nodes: [orderNode(2)],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ];
    const api = new FakeGraphql({ "orders(first:": () => pages.shift() });

    const orders: OrderData[] = [];
    for await (const page of fetchRecentPaidOrders(
      api,
      new Date("2026-08-17T09:00:00Z"),
    ))
      orders.push(...page);

    expect(orders.map((o) => o.id)).toEqual(["1", "2"]);
    expect(api.calls.at(-1)?.variables.after).toBe("c1");
    expect(api.calls[0].variables.q).toBe(
      "processed_at:>=2026-08-17 AND (financial_status:paid OR financial_status:partially_refunded)",
    );
  });
});

describe("order lookup by number", () => {
  const lookupNode = (customerId: string | null = "77") =>
    orderNode(9, {
      name: "#1042",
      email: "Sarah@Example.com",
      customerId,
      lineItems: {
        nodes: [
          {
            ...orderNode(9).lineItems.nodes[0],
            id: "gid://shopify/LineItem/55",
            title: "Aria Boot",
            variantTitle: "UK 7",
            quantity: 2,
            image: { url: "https://cdn/aria.jpg" },
          },
        ],
      },
    });
  const fake = (node = lookupNode()) =>
    new FakeGraphql({ "orders(first:": { orders: { nodes: [node] } } });

  it("normalises order numbers", () => {
    expect(["1042", " #1042 ", "#lx-7"].map(normaliseOrderNumber)).toEqual([
      "1042",
      "1042",
      "LX-7",
    ]);
    expect(normaliseOrderNumber("1042 OR name:*")).toBeNull();
  });

  it("a guest finds the order with its number and email (any case)", async () => {
    const api = fake();

    const order = await findOrderByNumber(api, "1042", {
      email: " sarah@example.COM ",
    });

    expect(order?.name).toBe("#1042");
    expect(order?.lines.map((l) => [l.id, l.quantity, l.imageUrl])).toEqual([
      ["55", 2, "https://cdn/aria.jpg"],
    ]);
    expect(api.calls[0].variables.q).toBe("name:1042");
  });

  it("a wrong email, a missing email or another order's number finds nothing", async () => {
    const api = fake();
    expect(
      await findOrderByNumber(api, "#1042", { email: "someone@example.com" }),
    ).toBeNull();
    expect(await findOrderByNumber(api, "#1042", { email: "" })).toBeNull();
    expect(
      await findOrderByNumber(api, "#104", { email: "sarah@example.com" }),
    ).toBeNull();
  });

  it("a logged-in customer only finds their own orders", async () => {
    expect(
      await findOrderByNumber(fake(), "1042", { customerId: "77" }),
    ).not.toBeNull();
    expect(
      await findOrderByNumber(fake(), "1042", { customerId: "88" }),
    ).toBeNull();
    expect(
      await findOrderByNumber(fake(lookupNode(null)), "1042", {
        customerId: "77",
      }),
    ).toBeNull();
  });

  it("a failure finds nothing", async () => {
    const api = new FakeGraphql({
      "orders(first:": () => {
        throw new Error("boom");
      },
    });
    expect(
      await findOrderByNumber(api, "1042", { customerId: "77" }, quiet),
    ).toBeNull();
  });
});

describe("purchase history", () => {
  const variantLine = (
    variantId: number,
    productId: number,
    title: string,
  ) => ({
    id: `gid://shopify/LineItem/${variantId}0`,
    image: null,
    variant: {
      id: `gid://shopify/ProductVariant/${variantId}`,
      title: "UK 9",
      media: {
        nodes: [
          { preview: { image: { url: `https://cdn/img-${variantId}.jpg` } } },
        ],
      },
      product: {
        id: `gid://shopify/Product/${productId}`,
        title,
        featuredMedia: { preview: { image: { url: "https://cdn/p.jpg" } } },
      },
    },
  });
  const historyData = (...orders: unknown[]) => ({
    customer: { orders: { nodes: orders } },
  });
  const fake = (data: unknown) => new FakeGraphql({ "customer(id:": data });

  it("returns an empty list without a customer id", async () => {
    const api = fake(historyData());
    expect(await fetchPurchaseHistory(api, null)).toEqual([]);
    expect(api.calls).toHaveLength(0);
  });

  it("maps purchased line items to products with numeric ids", async () => {
    const api = fake(
      historyData({
        id: "gid://shopify/Order/1",
        name: "#1042",
        processedAt: "2026-01-01T00:00:00Z",
        lineItems: { nodes: [variantLine(100, 10, "Aria Boot")] },
      }),
    );

    const items = await fetchPurchaseHistory(api, "777");

    expect(items).toEqual([
      {
        productId: "10",
        variantId: "100",
        productTitle: "Aria Boot",
        variantTitle: "UK 9",
        imageUrl: "https://cdn/img-100.jpg",
        orderName: "#1042",
        orderDate: "2026-01-01T00:00:00Z",
        orderId: "1",
        orderLineId: "1000",
      },
    ]);
    expect(api.calls[0].variables.id).toBe("gid://shopify/Customer/777");
  });

  it("deduplicates by variant keeping the most recent order", async () => {
    const order = (id: number, name: string) => ({
      id: `gid://shopify/Order/${id}`,
      name,
      processedAt: null,
      lineItems: { nodes: [variantLine(100, 10, "Aria Boot")] },
    });
    const items = await fetchPurchaseHistory(
      fake(historyData(order(2, "#2"), order(1, "#1"))),
      "777",
    );
    expect(items.map((i) => i.orderName)).toEqual(["#2"]);
  });

  it("skips line items whose product was deleted", async () => {
    const items = await fetchPurchaseHistory(
      fake(
        historyData({
          id: "gid://shopify/Order/3",
          name: "#3",
          processedAt: null,
          lineItems: {
            nodes: [
              { id: "gid://shopify/LineItem/1", image: null, variant: null },
            ],
          },
        }),
      ),
      "777",
    );
    expect(items).toEqual([]);
  });

  it("returns an empty list when the API raises", async () => {
    const api = new FakeGraphql({
      "customer(id:": () => {
        throw new Error("boom");
      },
    });
    expect(await fetchPurchaseHistory(api, "777", quiet)).toEqual([]);
  });
});

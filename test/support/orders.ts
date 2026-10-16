/** OrderData / OrderLine builders for recorder, activator and lookup tests. */
import type { OrderData, OrderLine } from "../../app/shopify/orders.server";

export function orderLine(overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    id: "1",
    productId: "10",
    variantId: "100",
    title: "Aria Boot",
    variantTitle: "UK 7",
    sku: null,
    quantity: 1,
    requiresShipping: true,
    giftCard: false,
    unitPrice: "50.00",
    properties: {},
    imageUrl: null,
    ...overrides,
  };
}

export function orderData(overrides: Partial<OrderData> = {}): OrderData {
  return {
    id: "500",
    name: "#1042",
    processedAt: new Date(Date.now() - 86_400_000),
    customerId: "77",
    email: "a@example.com",
    customerName: "Sarah",
    tags: [],
    lines: [orderLine()],
    ...overrides,
  };
}

/** A GraphQL Order node (ORDER_FIELDS shape) for FakeGraphql responses. */
export function orderNode(
  id: string | number,
  {
    name = `#${id}`,
    customerId = "77" as string | null,
    email = "a@example.com",
    lines = [{ id: `${id}1`, quantity: 1 }] as { id: string; quantity: number; imageUrl?: string }[],
  } = {},
) {
  return {
    id: `gid://shopify/Order/${id}`,
    name,
    processedAt: "2026-09-01T00:00:00Z",
    createdAt: "2026-09-01T00:00:00Z",
    email,
    tags: [],
    customer: customerId
      ? { id: `gid://shopify/Customer/${customerId}`, displayName: "Sarah", defaultEmailAddress: null }
      : null,
    lineItems: {
      nodes: lines.map((line) => ({
        id: `gid://shopify/LineItem/${line.id}`,
        title: "Aria Boot",
        variantTitle: "UK 7",
        sku: null,
        quantity: line.quantity,
        requiresShipping: true,
        isGiftCard: false,
        customAttributes: [],
        discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: "50.00" } },
        image: line.imageUrl ? { url: line.imageUrl } : null,
        product: { id: "gid://shopify/Product/10" },
        variant: { id: "gid://shopify/ProductVariant/100" },
      })),
    },
  };
}

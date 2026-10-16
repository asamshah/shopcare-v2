/**
 * The ShopCare section of Shopify's Order confirmation email.
 *
 * ShopCare sends no email itself: Shopify does. The merchant pastes
 * ORDER_CONFIRMATION_SNIPPET (order-confirmation.liquid) into Settings →
 * Notifications → Order confirmation, once. It reads only what is on the order
 * when Shopify creates it (the email goes out before any webhook reaches
 * ShopCare):
 *
 *   attributes.repair_ticket_id …          the repair draft order's custom
 *                                          attributes (repairs/order-confirmation.server.ts)
 *   line.properties _shopcare_for / _shopcare_item, _shopcare_term_months,
 *   _shopcare_cover_ends, Product          the Care cart line's properties
 *                                          (extensions/repair-intake/assets/shopcare-pdp.js)
 *
 * Variables per https://help.shopify.com/en/manual/fulfillment/setup/notifications/email-variables
 * (`attributes`, `line_items`, `line.properties`, `created_at`).
 *
 * `renderOrderConfirmationSnippet` renders it with liquidjs, for the preview
 * in Settings → Emails and for the tests.
 */
import { Liquid } from "liquidjs";
import type { Shop } from "@prisma/client";
import snippet from "./order-confirmation.liquid?raw";
import { orderConfirmationAttributes } from "../repairs/order-confirmation.server";

export const ORDER_CONFIRMATION_SNIPPET: string = snippet;

/** The notification-template data the snippet reads (a small part of an order). */
export interface OrderConfirmationData {
  created_at: string;
  attributes: Record<string, string>;
  line_items: {
    title: string;
    variant_id: number | string;
    product?: { title: string };
    properties: Record<string, string>;
  }[];
}

const engine = new Liquid({ timezoneOffset: 0 });

export function renderOrderConfirmationSnippet(data: OrderConfirmationData): Promise<string> {
  return engine.parseAndRender(ORDER_CONFIRMATION_SNIPPET, data);
}

/**
 * Sample orders for the Settings preview: a repair order with this shop's
 * workshop details, and a product bought with a 2-year Care plan.
 */
export function previewOrders(
  shop: Pick<Shop, "shopifyDomain" | "settings">,
  now: Date = new Date(),
): { repair: OrderConfirmationData; care: OrderConfirmationData } {
  const attributes = Object.fromEntries(
    orderConfirmationAttributes(shop, { id: 1042, itemReceivedAt: null }, now).map((a) => [a.key, a.value]),
  );
  return {
    repair: {
      created_at: now.toISOString(),
      attributes: { repair_quotation_id: "1", repair_ticket_id: "1042", ...attributes },
      line_items: [{ title: "Resole", variant_id: 1, properties: {} }],
    },
    care: {
      created_at: now.toISOString(),
      attributes: {},
      line_items: [
        { title: "Chelsea Boot - 8", variant_id: 100, product: { title: "Chelsea Boot" }, properties: {} },
        {
          title: "ShopCare 2-year plan",
          variant_id: 7001,
          properties: { _shopcare_for: "100", _shopcare_term_months: "24" },
        },
      ],
    },
  };
}

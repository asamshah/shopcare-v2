/**
 * Refunds one Care line on its original order, back to the original payment
 * (Shopify's suggested refund transactions, in the presentment currency for
 * multi-currency orders). Returns the refund's GID. Port of
 * Care::PlanRefunder; the Shopify calls are refundLineItem in
 * app/shopify/refunds.server.ts.
 */
import type { Cover } from "@prisma/client";
import { coverName } from "../../models/cover.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";
import { refundLineItem } from "../../shopify/refunds.server";

export async function refundCarePlan(
  client: AdminGraphqlClient,
  cover: Pick<Cover, "shopifyOrderId" | "shopifyLineItemId" | "terms" | "kind">,
): Promise<string> {
  if (!cover.shopifyOrderId || !cover.shopifyLineItemId)
    throw new Error("This Care cover has no order line to refund");
  return refundLineItem(client, {
    orderId: cover.shopifyOrderId,
    lineItemId: cover.shopifyLineItemId,
    quantity: 1,
    note: `ShopCare: ${coverName(cover)} refunded with its item`,
  });
}

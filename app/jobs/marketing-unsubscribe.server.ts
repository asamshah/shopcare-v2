/**
 * After a customer unsubscribes through ShopCare's link (the suppression is
 * already recorded by the route), tell Shopify too, so the store's own
 * marketing and ShopCare agree: customerEmailMarketingConsentUpdate →
 * UNSUBSCRIBED (needs `write_customers`). Run as a job so a Shopify hiccup is
 * retried by the background function. Skipped when the shop is gone or the
 * customer is a guest (no Shopify consent record).
 */
import prisma from "../db.server";
import type { AdminGraphqlClient } from "../shopify/graphql.server";
import { unsubscribeFromEmailMarketing } from "../shopify/customers.server";
import type { JobPayload } from "./registry.server";

let clientOverride: ((shopDomain: string) => Promise<AdminGraphqlClient>) | undefined;
export function setMarketingUnsubscribeClient(
  client: ((shopDomain: string) => Promise<AdminGraphqlClient>) | undefined,
) {
  clientOverride = client;
}

export async function marketingUnsubscribeJob(payload: JobPayload): Promise<void> {
  const shopDomain = typeof payload.shop === "string" ? payload.shop : "";
  const customerId = typeof payload.customerId === "string" ? payload.customerId : "";
  if (!shopDomain || !customerId) return;
  const shop = await prisma.shop.findUnique({ where: { shopifyDomain: shopDomain } });
  if (!shop || shop.uninstalledAt) return;
  const client = clientOverride
    ? await clientOverride(shopDomain)
    : await (await import("../shopify/client.server")).adminClientForShop(shopDomain);
  await unsubscribeFromEmailMarketing(client, customerId);
}

/**
 * The NotificationDeps the "notification" job uses outside tests:
 *
 *   store                    Postgres (`notification_deliveries`)
 *   loadSettings             the Shop row (shop-settings.server.ts)
 *   hasEmailMarketingConsent Shopify, via the shop's offline-session client
 *   adminClient              `unauthenticated.admin(shop)` (client.server.ts)
 *   unsubscribeUrl           not yet: the signed unsubscribe route is wave 2
 *                            (webhooks/jobs). Until it exists the marketing
 *                            "Add Care" email is skipped ("No unsubscribe link
 *                            available"); transactional emails are unaffected.
 */
import prisma from "../../db.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";
import type { NotificationDeps } from "../notifications.server";
import { shopifyMarketingConsent } from "./consent.server";
import { PrismaNotificationStore } from "./prisma-store.server";
import { loadNotificationSettings } from "./shop-settings.server";

async function adminClient(shopDomain: string): Promise<AdminGraphqlClient> {
  // Imported lazily: client.server loads the Shopify app config.
  const { adminClientForShop } = await import("../../shopify/client.server");
  return adminClientForShop(shopDomain);
}

export function productionNotificationDeps(): NotificationDeps {
  return {
    store: new PrismaNotificationStore(prisma),
    loadSettings: (shopDomain) => loadNotificationSettings(shopDomain, prisma),
    hasEmailMarketingConsent: async (recipient, { shopId }) =>
      shopifyMarketingConsent(await adminClient(shopId))(recipient),
    adminClient,
  };
}

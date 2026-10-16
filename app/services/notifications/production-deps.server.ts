/**
 * The NotificationDeps the "notification" job uses outside tests:
 *
 *   store         Postgres (`notification_deliveries`)
 *   loadSettings  the Shop row (shop-settings.server.ts)
 *   adminClient   `unauthenticated.admin(shop)` (client.server.ts), for Flow
 */
import prisma from "../../db.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";
import type { NotificationDeps } from "../notifications.server";
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
    adminClient,
  };
}

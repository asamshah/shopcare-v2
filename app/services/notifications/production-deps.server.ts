/**
 * The NotificationDeps the "notification" job uses outside tests:
 *
 *   store                    Postgres (`notification_deliveries`)
 *   loadSettings             the Shop row (shop-settings.server.ts)
 *   hasEmailMarketingConsent Shopify, via the shop's offline-session client
 *   adminClient              `unauthenticated.admin(shop)` (client.server.ts)
 *   unsubscribeUrl           the signed one-click link served by
 *                            app/routes/email.unsubscribe.tsx (enables the
 *                            marketing "Add Care" email)
 *   isSuppressed             the `email_suppressions` list (unsubscribes,
 *                            Resend bounces and complaints)
 *   attachments              the postage slip PDF for "Send your item to us"
 */
import prisma from "../../db.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";
import type { NotificationDeps } from "../notifications.server";
import { shopifyMarketingConsent } from "./consent.server";
import { PrismaNotificationStore } from "./prisma-store.server";
import { loadNotificationSettings } from "./shop-settings.server";
import { isEmailSuppressed } from "./suppressions.server";
import { unsubscribeUrl } from "./unsubscribe.server";
import { postageSlipAttachments } from "../repairs/postage-slip.server";

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
    unsubscribeUrl: (shopDomain, recipient) =>
      unsubscribeUrl(shopDomain, recipient),
    isSuppressed: (shopDomain, email, options) =>
      isEmailSuppressed(shopDomain, email, options, prisma),
    attachments: (delivery) => postageSlipAttachments(delivery),
  };
}

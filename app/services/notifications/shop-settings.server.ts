/**
 * Loads ShopNotificationSettings from the Shop row (settings.notifications,
 * snake_case keys like the rest of Shop.settings; see notificationsSettings in
 * app/models/shop.server.ts):
 *
 *   flow                   Flow triggers on/off (default off)
 *   care_offer_delay_days  days after purchase for the "Add Care" offer (7)
 *
 * The Klaviyo key is the shop's encrypted secret. Returns null when the shop
 * is gone or uninstalled.
 */
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import {
  careOfferDelayDays,
  flowEnabled,
  shopSecret,
} from "../../models/shop.server";
import type { ShopNotificationSettings } from "./settings.server";

export async function loadNotificationSettings(
  shopifyDomain: string,
  db: Db = prisma,
): Promise<ShopNotificationSettings | null> {
  const shop = await db.shop.findUnique({ where: { shopifyDomain } });
  if (!shop || shop.uninstalledAt) return null;
  return {
    shopId: shop.shopifyDomain,
    flowEnabled: flowEnabled(shop),
    klaviyoApiKey: shopSecret(shop, "klaviyoApiKey"),
    careOfferDelayDays: careOfferDelayDays(shop),
  };
}

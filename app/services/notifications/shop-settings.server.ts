/**
 * Loads ShopNotificationSettings from the Shop row (settings.notifications,
 * snake_case keys like the rest of Shop.settings; see notificationsSettings in
 * app/models/shop.server.ts):
 *
 *   flow                   Flow triggers on/off (default off)
 *   staff_email            "Notify staff at"
 *   support_email          Reply-To (falls back to settings.contact_email)
 *   logo_url, accent_color, address_lines, store_url, locale
 *   emails                 { <email kind>: { enabled, subject, intro } }
 *   care_offer_delay_days  days after purchase for the "Add Care" offer (7)
 *
 * The Klaviyo key is the shop's encrypted secret. The shop name is the one
 * storeName() remembered (settings.shop_name), else the domain's handle.
 * Returns null when the shop is gone or uninstalled.
 */
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import {
  careOfferDelayDays,
  notificationsSettings,
  settingsOf,
  shopSecret,
} from "../../models/shop.server";
import { storeNameFromDomain } from "../../shopify/shop.server";
import { EMAIL_KINDS, type EmailKind } from "./events.server";
import type { EmailSettings, ShopNotificationSettings } from "./settings.server";

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

function emailSettings(value: unknown): ShopNotificationSettings["emails"] {
  if (!value || typeof value !== "object") return {};
  const emails: Partial<Record<EmailKind, EmailSettings>> = {};
  for (const kind of EMAIL_KINDS) {
    const raw = (value as Record<string, unknown>)[kind];
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    emails[kind] = {
      ...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
      subject: text(entry.subject),
      intro: text(entry.intro),
    };
  }
  return emails;
}

export async function loadNotificationSettings(
  shopifyDomain: string,
  db: Db = prisma,
): Promise<ShopNotificationSettings | null> {
  const shop = await db.shop.findUnique({ where: { shopifyDomain } });
  if (!shop || shop.uninstalledAt) return null;
  const all = settingsOf(shop);
  const n = notificationsSettings(shop);
  const addressLines = Array.isArray(n.address_lines)
    ? n.address_lines.map(String).filter((line) => line.trim())
    : null;
  return {
    shopId: shop.shopifyDomain,
    shopName: text(all.shop_name) ?? storeNameFromDomain(shop.shopifyDomain),
    logoUrl: text(n.logo_url),
    accentColor: text(n.accent_color),
    addressLines,
    storeUrl: text(n.store_url) ?? `https://${shop.shopifyDomain}`,
    supportEmail: text(n.support_email) ?? text(all.contact_email),
    staffEmail: text(n.staff_email),
    locale: text(n.locale),
    emails: emailSettings(n.emails),
    flowEnabled: n.flow === true || n.flow === "true",
    klaviyoApiKey: shopSecret(shop, "klaviyoApiKey"),
    careOfferDelayDays: careOfferDelayDays(shop),
  };
}

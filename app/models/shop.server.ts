/**
 * A shop that installed ShopCare: its settings (jsonb, keys as in Rails) and
 * its encrypted secrets. Shopify access tokens live in Session (the template's
 * session storage), so unlike the Rails `shops` table there's no token here.
 * Port of Shop.
 */
import type { Prisma, Shop } from "@prisma/client";
import prisma from "../db.server";
import type { Db } from "../lib/db-lock.server";
import { decrypt, encrypt } from "../lib/encryption.server";
import { castBoolean, compactBlank, titleize } from "../lib/inflections";
import { d, jsonObject } from "./validation.server";

export type ShopSettings = Record<string, unknown>;

export const settingsOf = (shop: Pick<Shop, "settings">): ShopSettings =>
  jsonObject(shop.settings);

const DEFAULT_PROXY_PATH_PREFIX = "/apps/repairs";

// --- Encrypted secrets ------------------------------------------------------

/** Secrets stored per shop, encrypted with app/lib/encryption.server.ts. */
export const SHOP_SECRETS = {
  klaviyoApiKey: "klaviyoApiKeyCiphertext",
  customerSigningKey: "customerSigningKeyCiphertext",
  webhookSecret: "webhookSecretCiphertext",
} as const;
export type ShopSecret = keyof typeof SHOP_SECRETS;

const secretContext = (field: ShopSecret) => `Shop.${field}`;

/** The decrypted secret, or null when none is stored. */
export function shopSecret(
  shop: Pick<Shop, (typeof SHOP_SECRETS)[ShopSecret]>,
  field: ShopSecret,
): string | null {
  const ciphertext = shop[SHOP_SECRETS[field]];
  return ciphertext ? decrypt(ciphertext, secretContext(field)) : null;
}

/** Column data for a secret: ciphertext, or null to clear it (blank clears). */
export function shopSecretData(field: ShopSecret, value: string | null | undefined) {
  const plaintext = value?.trim() ? value : null;
  return {
    [SHOP_SECRETS[field]]: plaintext ? encrypt(plaintext, secretContext(field)) : null,
  } as Partial<Record<(typeof SHOP_SECRETS)[ShopSecret], string | null>>;
}

export function setShopSecret(
  shopId: number,
  field: ShopSecret,
  value: string | null,
  db: Db = prisma,
): Promise<Shop> {
  return db.shop.update({ where: { id: shopId }, data: shopSecretData(field, value) });
}

// --- Settings -----------------------------------------------------------------

/**
 * Trade-in is parked for V2 (docs/ROADMAP.md): off unless switched on per
 * shop (settings.trade_in_enabled).
 */
export function tradeInEnabled(shop: Pick<Shop, "settings">): boolean {
  return castBoolean(settingsOf(shop).trade_in_enabled);
}

/**
 * Workshop inventory (Settings → Workshop inventory) is optional and off for
 * new shops.
 */
export function partsEnabled(shop: Pick<Shop, "settings">): boolean {
  return castBoolean(settingsOf(shop).parts_enabled);
}

export function tradeInSettings(shop: Pick<Shop, "settings">): Record<string, unknown> {
  return {
    credit_method: "store_credit",
    credit_days: "365",
    ...compactBlank(jsonObject(settingsOf(shop).trade_in as Prisma.JsonValue)),
  };
}

/** Care plan behaviour (Settings → Care plans). */
export function careSettings(shop: Pick<Shop, "settings">): Record<string, unknown> {
  return {
    refund_action: "refund",
    credit_scope: "care",
    credit_days: "90",
    add_later_url: "",
    ...compactBlank(jsonObject(settingsOf(shop).care as Prisma.JsonValue)),
  };
}

export function notificationsSettings(shop: Pick<Shop, "settings">): Record<string, unknown> {
  return { flow: true, ...jsonObject(settingsOf(shop).notifications as Prisma.JsonValue) };
}

/**
 * Workshop settings. "model_metafield" was "sole_model_metafield" before
 * 16-10-2026; the old key is still read.
 */
export function partsSettings(shop: Pick<Shop, "settings">): Record<string, unknown> {
  const stored: Record<string, unknown> = compactBlank(
    jsonObject(settingsOf(shop).parts as Prisma.JsonValue),
  );
  if (stored.sole_model_metafield) {
    stored.model_metafield ??= stored.sole_model_metafield;
    delete stored.sole_model_metafield;
  }
  return {
    size_option: "Size",
    colour_option: "Color, Colour",
    model_metafield: "",
    labour_rate: "0",
    ...stored,
  };
}

export function labourRate(shop: Pick<Shop, "settings">): Prisma.Decimal {
  return d(partsSettings(shop).labour_rate);
}

/** Settings after choosing the collection repair services are imported from. */
export function withRepairCollection(
  shop: Pick<Shop, "settings">,
  collectionId: string | number,
  title: string | null | undefined,
): ShopSettings {
  const settings = settingsOf(shop);
  const source = {
    mode: "collection",
    collection_id: String(collectionId).match(/\d+$/)?.[0] ?? "",
    collection_title: String(title ?? "").trim(),
  };
  return {
    ...settings,
    repair_products: { ...jsonObject(settings.repair_products as Prisma.JsonValue), ...source },
  };
}

export function useRepairCollection(
  shop: Pick<Shop, "id" | "settings">,
  collectionId: string | number,
  title: string | null | undefined,
  db: Db = prisma,
): Promise<Shop> {
  return db.shop.update({
    where: { id: shop.id },
    data: { settings: withRepairCollection(shop, collectionId, title) as Prisma.InputJsonValue },
  });
}

/** Tag on draft orders created from repair quotes (tells repair payments apart). */
export function repairOrderTag(shop: Pick<Shop, "settings">): string {
  const tag = settingsOf(shop).repair_order_tag;
  return typeof tag === "string" && tag.trim() ? tag : "repair";
}

/** Days a customer has to pay (accept) a sent quote's invoice. */
export function quoteValidDays(shop: Pick<Shop, "settings">): number {
  const days = parseInt(String(settingsOf(shop).quote_valid_days ?? ""), 10);
  return days > 0 ? days : 14;
}

export function proxyPathPrefix(shop: Pick<Shop, "settings">): string {
  const prefix = settingsOf(shop).proxy_path_prefix;
  return typeof prefix === "string" && prefix.trim() ? prefix : DEFAULT_PROXY_PATH_PREFIX;
}

/** The storefront URL of an App Proxy page, e.g. a quote's review page. */
export function proxyUrl(shop: Pick<Shop, "shopifyDomain" | "settings">, path: string): string {
  return `https://${shop.shopifyDomain}${proxyPathPrefix(shop)}/${path}`;
}

/** Show the first-run setup on the admin home until it's finished or skipped. */
export function needsSetup(shop: Pick<Shop, "setupCompletedAt">): boolean {
  return shop.setupCompletedAt === null;
}

export interface ShopNameSource {
  shopName(): Promise<string | null | undefined>;
}

/**
 * The store's name for customer-facing copy: read from Shopify once and
 * remembered in settings; the domain's handle if that fails.
 */
export async function storeName(
  shop: Pick<Shop, "id" | "shopifyDomain" | "settings">,
  api: ShopNameSource,
  db: Db = prisma,
): Promise<string> {
  const remembered = settingsOf(shop).shop_name;
  if (typeof remembered === "string" && remembered.trim()) return remembered;
  try {
    const name = (await api.shopName())?.trim();
    if (name) {
      await db.shop.update({
        where: { id: shop.id },
        data: { settings: { ...settingsOf(shop), shop_name: name } as Prisma.InputJsonValue },
      });
      return name;
    }
  } catch (error) {
    console.warn(`[storeName] ${shop.shopifyDomain}: ${String(error)}`);
  }
  return titleize(shop.shopifyDomain.replace(/\.myshopify\.com$/, "").replace(/-/g, " "));
}

/** The shop row for a domain, created on first sight (install). */
export function findOrCreateShop(shopifyDomain: string, db: Db = prisma): Promise<Shop> {
  return db.shop.upsert({
    where: { shopifyDomain },
    create: { shopifyDomain, installedAt: new Date() },
    update: {},
  });
}

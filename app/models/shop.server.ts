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
export function shopSecret<F extends ShopSecret>(
  shop: Pick<Shop, (typeof SHOP_SECRETS)[F]>,
  field: F,
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

// --- Customer signing key (Shopify::CustomerSigningKey) ----------------------

/**
 * The state `ensureCustomerSigningKey` (app/shopify/customer-signing-key.server.ts)
 * starts from: the decrypted key and when it was last published (Rails kept
 * that in settings["customer_signing_key_published_at"]).
 */
export function customerSigningKeyState(
  shop: Pick<Shop, "settings" | "customerSigningKeyCiphertext">,
): { key: string | null; publishedAt: string | null } {
  const publishedAt = settingsOf(shop).customer_signing_key_published_at;
  return {
    key: shopSecret(shop, "customerSigningKey"),
    publishedAt: typeof publishedAt === "string" && publishedAt ? publishedAt : null,
  };
}

/**
 * The `save` callback for ensure/rotateCustomerSigningKey: writes the key to
 * the encrypted column and the publish time to settings, re-reading settings
 * so a concurrent settings change isn't lost.
 */
export function saveCustomerSigningKey(shopId: number, db: Db = prisma) {
  return async (state: { key: string | null; publishedAt: string | null }) => {
    const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } });
    const settings = { ...settingsOf(shop) };
    if (state.publishedAt) settings.customer_signing_key_published_at = state.publishedAt;
    else delete settings.customer_signing_key_published_at;
    await db.shop.update({
      where: { id: shopId },
      data: {
        ...shopSecretData("customerSigningKey", state.key),
        settings: settings as Prisma.InputJsonValue,
      },
    });
  };
}

/**
 * The decrypted customer signing key for a shop domain, or null (no shop row,
 * or no key yet). The App Proxy's `customerSigningKey` lookup.
 */
export async function customerSigningKeyFor(
  shopifyDomain: string,
  db: Db = prisma,
): Promise<string | null> {
  const shop = await db.shop.findUnique({
    where: { shopifyDomain },
    select: { customerSigningKeyCiphertext: true },
  });
  return shop ? shopSecret(shop, "customerSigningKey") : null;
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

/**
 * Notification settings (settings.notifications): `flow` (Shopify Flow
 * triggers, OFF unless the merchant turns it on: ShopCare works fully without
 * Flow), `care_offer_delay_days` (how many days after purchase the "Add Care"
 * offer goes out, see careOfferDelayDays) and `status_url` (the storefront
 * Repair status page).
 */
export function notificationsSettings(shop: Pick<Shop, "settings">): Record<string, unknown> {
  return {
    flow: false,
    care_offer_delay_days: DEFAULT_CARE_OFFER_DELAY_DAYS,
    ...jsonObject(settingsOf(shop).notifications as Prisma.JsonValue),
  };
}

/** Is the Shopify Flow integration on (Settings → Emails)? Off by default. */
export function flowEnabled(shop: Pick<Shop, "settings">): boolean {
  const flow = notificationsSettings(shop).flow;
  return flow === true || flow === "true";
}

export const DEFAULT_CARE_OFFER_DELAY_DAYS = 7;

/**
 * The storefront page with the Repair status block
 * (settings.notifications.status_url), linked from the Order confirmation
 * snippet and the repair form's confirmation. Only an absolute http(s) URL; null when not set.
 */
export function repairStatusUrl(shop: Pick<Shop, "settings">): string | null {
  const value = notificationsSettings(shop).status_url;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The ticket in the ShopCare admin (app.tickets.$id → /app/tickets/:id),
 * for Flow staff alerts and the postage slip's QR code. SHOPIFY_APP_HANDLE is the app's handle in the admin URL.
 */
export function adminTicketUrl(shopDomain: string, ticketId: number): string {
  return adminAppUrl(shopDomain, `tickets/${ticketId}`);
}

/** A page of the ShopCare admin, e.g. adminAppUrl(shop, "settings"). */
export function adminAppUrl(shopDomain: string, path: string): string {
  const store = shopDomain.replace(/\.myshopify\.com$/, "");
  const handle = process.env.SHOPIFY_APP_HANDLE || "shopcare";
  return `https://admin.shopify.com/store/${store}/apps/${handle}/app/${path}`;
}

/**
 * Days after purchase the "Add Care to your purchase" offer is emitted by the
 * daily care-offers job (netlify/functions/daily-care-offers.mts).
 */
export function careOfferDelayDays(shop: Pick<Shop, "settings">): number {
  const days = parseInt(String(notificationsSettings(shop).care_offer_delay_days ?? ""), 10);
  return days > 0 ? days : DEFAULT_CARE_OFFER_DELAY_DAYS;
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

/**
 * Remembers a merchant-customised App Proxy path (Rails
 * `remember_path_prefix`): writes settings.proxy_path_prefix only when it
 * changed. No-op for a shop without a row.
 */
export async function rememberProxyPathPrefix(
  shopifyDomain: string,
  prefix: string,
  db: Db = prisma,
): Promise<void> {
  const shop = await db.shop.findUnique({ where: { shopifyDomain } });
  if (!shop || proxyPathPrefix(shop) === prefix) return;
  await db.shop.update({
    where: { id: shop.id },
    data: { settings: { ...settingsOf(shop), proxy_path_prefix: prefix } as Prisma.InputJsonValue },
  });
}

/** The storefront URL of an App Proxy page, e.g. a quote's review page. */
export function proxyUrl(shop: Pick<Shop, "shopifyDomain" | "settings">, path: string): string {
  return `https://${shop.shopifyDomain}${proxyPathPrefix(shop)}/${path}`;
}

// --- Postage slips: where customers post their items -----------------------

/** Settings → Repairs → Workshop address (settings.workshop_address). */
export interface WorkshopAddress {
  name: string;
  line1: string;
  line2: string;
  city: string;
  postcode: string;
  country: string;
}

export const WORKSHOP_ADDRESS_FIELDS = ["name", "line1", "line2", "city", "postcode", "country"] as const;
/** Everything but the second address line is needed before slips can be made. */
export const REQUIRED_WORKSHOP_FIELDS = ["name", "line1", "city", "postcode", "country"] as const;

export const DEFAULT_POSTING_INSTRUCTIONS =
  "Pack your item securely and use a tracked service. Put the packing slip inside the parcel.";

export function workshopAddress(shop: Pick<Shop, "settings">): WorkshopAddress {
  const stored = jsonObject(settingsOf(shop).workshop_address as Prisma.JsonValue);
  return Object.fromEntries(
    WORKSHOP_ADDRESS_FIELDS.map((key) => [key, typeof stored[key] === "string" ? String(stored[key]).trim() : ""]),
  ) as unknown as WorkshopAddress;
}

/** The workshop address, or null until every required field is filled in. */
export function completeWorkshopAddress(shop: Pick<Shop, "settings">): WorkshopAddress | null {
  const address = workshopAddress(shop);
  return REQUIRED_WORKSHOP_FIELDS.every((key) => address[key]) ? address : null;
}

/** Address lines for a label: name, street, town and postcode, country. */
export function workshopAddressLines(address: WorkshopAddress): string[] {
  return [
    address.name,
    address.line1,
    address.line2,
    [address.city, address.postcode].filter(Boolean).join(" "),
    address.country,
  ].filter((line) => line.trim());
}

/** Settings → Repairs → Posting instructions, printed on the slip and in the email. */
export function postingInstructions(shop: Pick<Shop, "settings">): string {
  const value = settingsOf(shop).posting_instructions;
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_POSTING_INSTRUCTIONS;
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

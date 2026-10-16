/**
 * The shop's own details: the name customers see (quote email subject, email
 * From name), its emails (contactEmail is the customer-facing one, the
 * default Reply-To) and currency. Ported from Rails `AdminApi#shop_name` and
 * `Shop#store_name`; the caller remembers the name in the shop's settings.
 */
import { adminGraphql, type AdminGraphqlClient } from "./graphql.server";

export const SHOP_INFO_QUERY = `#graphql
  query ShopInfo {
    shop { name email contactEmail currencyCode myshopifyDomain }
  }
`;

export interface ShopInfo {
  name: string;
  /** The shop owner's email (Shopify uses it to contact the merchant). */
  email: string;
  /** The email customers see (store notifications' sender / Reply-To). */
  contactEmail: string;
  /** ISO 4217, e.g. "GBP". */
  currencyCode: string;
  myshopifyDomain: string;
}

export async function fetchShopInfo(
  client: AdminGraphqlClient,
): Promise<ShopInfo> {
  const data = await adminGraphql<{ shop: ShopInfo }>(client, SHOP_INFO_QUERY);
  return data.shop;
}

/** The store's name, trimmed; null when Shopify gives none. */
export async function fetchShopName(
  client: AdminGraphqlClient,
): Promise<string | null> {
  const name = (await fetchShopInfo(client)).name?.trim();
  return name ? name : null;
}

/**
 * The fallback when the name can't be read: "acme-boots.myshopify.com" →
 * "Acme Boots" (Rails `Shop#store_name`).
 */
export function storeNameFromDomain(shopDomain: string): string {
  return shopDomain
    .replace(/\.myshopify\.com$/, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

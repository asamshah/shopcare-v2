/**
 * Shopify GraphQL ids are GIDs ("gid://shopify/Product/123"); REST, webhook
 * and storefront payloads use the bare numeric id. ShopCare stores and
 * compares the bare numeric id as a string (as Rails did), so these convert
 * between the two. Ids are always strings: Shopify ids can outgrow a JS
 * number's exact range. Ported from Rails `Shopify::Gid`.
 */

/**
 * "gid://shopify/Product/123" → "123"; a bare id is returned unchanged;
 * null/undefined/"" give "".
 */
export function numericId(gid: string | number | null | undefined): string {
  const last = String(gid ?? "").split("/").pop() ?? "";
  // GIDs can carry a query string (e.g. "…/LineItem/1?foo=bar").
  return last.split("?")[0];
}

/** ("Product", 123) → "gid://shopify/Product/123". A GID passes through. */
export function buildGid(type: string, id: string | number): string {
  const value = String(id);
  return value.startsWith("gid://") ? value : `gid://shopify/${type}/${value}`;
}

/** numericId for a value that may be missing: null instead of "". */
export function numericIdOrNull(
  gid: string | number | null | undefined,
): string | null {
  return gid === null || gid === undefined || gid === ""
    ? null
    : numericId(gid);
}

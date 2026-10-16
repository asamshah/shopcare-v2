/**
 * Shopify GraphQL ids are GIDs ("gid://shopify/Product/123"). ShopCare stores
 * and compares the bare numeric id (as Rails did, and as webhook payloads use),
 * so these convert between the two. Ported from Rails `Shopify::Gid`.
 */

/** "gid://shopify/Product/123" → "123"; a bare id is returned unchanged. */
export function numericId(gid: string | number): string {
  const value = String(gid);
  const last = value.split("/").pop() ?? "";
  // GIDs can carry a query string (e.g. "…/LineItem/1?foo=bar").
  return last.split("?")[0];
}

/** ("Product", 123) → "gid://shopify/Product/123". A GID passes through. */
export function buildGid(type: string, id: string | number): string {
  const value = String(id);
  return value.startsWith("gid://") ? value : `gid://shopify/${type}/${value}`;
}

/** numericId for a value that may be missing. */
export function numericIdOrNull(
  gid: string | number | null | undefined,
): string | null {
  return gid === null || gid === undefined || gid === ""
    ? null
    : numericId(gid);
}

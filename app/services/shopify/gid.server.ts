/**
 * Shopify GraphQL ids are GIDs ("gid://shopify/Product/123"); REST and
 * storefront payloads use the bare numeric id. Port of Shopify::Gid.
 */
export function numericId(gid: string | number | null | undefined): string {
  return String(gid ?? "").split("/").pop() ?? "";
}

export function buildGid(type: string, id: string | number): string {
  return `gid://shopify/${type}/${id}`;
}

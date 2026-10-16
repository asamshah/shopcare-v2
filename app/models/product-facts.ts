/**
 * The product details eligibility rules are decided on: tags, product type and
 * collections. Port of Warranty::ProductFacts::Facts (the struct only; the
 * loader that fetches them from Shopify is ProductFactsLoader in
 * app/shopify/product-facts.server.ts).
 */
export interface ProductFacts {
  productId?: string | null;
  title?: string | null;
  productType?: string | null;
  tags: string[];
  /** Numeric collection ids, as strings. */
  collectionIds: string[];
  variantId?: string | null;
  variantTitle?: string | null;
  sku?: string | null;
}

export function emptyFacts(productId: string | null = null): ProductFacts {
  return { productId, tags: [], collectionIds: [] };
}

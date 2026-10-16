/**
 * The product details eligibility rules are decided on: tags, product type and
 * collections. Port of Warranty::ProductFacts::Facts (the struct only; the
 * service that fetches them from Shopify is app/services/warranty/product-facts).
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

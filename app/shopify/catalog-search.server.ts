/**
 * "Find the product you bought": searches the shop's own catalogue by product
 * name or SKU for the storefront repair form, for items bought elsewhere or in
 * store. Returns public catalogue facts only (title, image, variant, SKU, ids)
 * for active, published products, never gift cards, repair services or Care
 * plans (the caller passes their variant ids). Ported from Rails
 * `Repairs::CatalogSearch`.
 */
import { cached, defaultShopifyCache, type ShopifyCache } from "./cache.server";
import { numericId } from "./gid.server";
import {
  adminGraphql,
  errorSummary,
  type AdminGraphqlClient,
} from "./graphql.server";

export const CATALOG_SEARCH_MIN_LENGTH = 2;
export const CATALOG_SEARCH_MAX_LENGTH = 60;
export const CATALOG_SEARCH_MAX_RESULTS = 10;
export const CATALOG_SEARCH_TTL_MS = 5 * 60 * 1000;

export const CATALOG_SEARCH_QUERY = `#graphql
  query CatalogSearch($q: String!, $first: Int!) {
    products(first: $first, query: $q) {
      nodes {
        id title featuredMedia { preview { image { url } } }
        variants(first: 50) {
          nodes { id title sku media(first: 1) { nodes { preview { image { url } } } } }
        }
      }
    }
  }
`;

export interface CatalogVariant {
  variantId: string;
  variantTitle: string | null;
  sku: string | null;
}

export interface CatalogResult {
  productId: string;
  productTitle: string;
  imageUrl: string | null;
  /** Set when a SKU matched or the product has one variant. */
  variantId: string | null;
  variantTitle: string | null;
  sku: string | null;
  /** The variants to choose from, when none was chosen. */
  variants: CatalogVariant[] | null;
}

/**
 * Letters, digits and the punctuation SKUs use; everything else (quotes,
 * colons, brackets: Shopify search syntax) becomes a space.
 */
export function cleanCatalogTerm(term: unknown): string {
  return String(term ?? "")
    .replace(/[^\p{L}\p{N}\s._/-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CATALOG_SEARCH_MAX_LENGTH);
}

/**
 * Title words as prefixes, or an exact SKU. Words can't start with "-"
 * (Shopify reads that as NOT).
 */
export function catalogSearchQuery(term: string): string {
  const words = term
    .split(" ")
    .map((word) => word.replace(/^-+/, ""))
    .filter(Boolean);
  const title = words.map((word) => `title:${word}*`).join(" AND ");
  const match = term.includes(" ")
    ? `(${title})`
    : `((${title}) OR sku:${term})`;
  return `status:active AND published_status:published AND gift_card:false AND ${match}`;
}

interface MediaNode {
  preview: { image: { url: string } | null } | null;
}

interface ProductNode {
  id: string;
  title: string;
  featuredMedia: MediaNode | null;
  variants: {
    nodes: {
      id: string;
      title: string;
      sku: string | null;
      media: { nodes: MediaNode[] } | null;
    }[];
  };
}

export interface CatalogSearchOptions {
  /** Identifies the shop in cache keys (e.g. its domain). */
  shopKey: string;
  /** Numeric variant ids of repair services and Care plans, left out. */
  excludedVariantIds?: Iterable<string>;
  cache?: ShopifyCache;
  logger?: Pick<Console, "error">;
}

/** Never throws: a failure is logged and gives [] (and isn't cached). */
export async function searchCatalog(
  client: AdminGraphqlClient,
  rawTerm: unknown,
  options: CatalogSearchOptions,
): Promise<CatalogResult[]> {
  const term = cleanCatalogTerm(rawTerm);
  if (term.length < CATALOG_SEARCH_MIN_LENGTH) return [];
  const excluded = new Set(
    [...(options.excludedVariantIds ?? [])].map((id) => String(id)),
  );
  try {
    return (
      (await cached(
        options.cache ?? defaultShopifyCache,
        `catalog-search:${options.shopKey}:${term.toLowerCase()}`,
        CATALOG_SEARCH_TTL_MS,
        async () => {
          // Over-fetch: repair services and Care plans are dropped afterwards.
          const data = await adminGraphql<{
            products: { nodes: ProductNode[] };
          }>(client, CATALOG_SEARCH_QUERY, {
            q: catalogSearchQuery(term),
            first: CATALOG_SEARCH_MAX_RESULTS * 2,
          });
          return (data.products?.nodes ?? [])
            .filter((node) => !isExcluded(node, excluded))
            .slice(0, CATALOG_SEARCH_MAX_RESULTS)
            .map((node) => result(node, term));
        },
      )) ?? []
    );
  } catch (error) {
    (options.logger ?? console).error(
      `[shopify/catalog-search] ${options.shopKey}: ${errorSummary(error)}`,
    );
    return [];
  }
}

function isExcluded(node: ProductNode, excluded: Set<string>): boolean {
  return (node.variants?.nodes ?? []).some((v) =>
    excluded.has(numericId(v.id)),
  );
}

/**
 * One row per product. A SKU match (or a product with one variant) names its
 * variant; otherwise the customer can say which one from `variants`.
 */
function result(node: ProductNode, term: string): CatalogResult {
  const variants = (node.variants?.nodes ?? []).map((v) => ({
    variantId: numericId(v.id),
    variantTitle: titleOrNull(v.title),
    sku: v.sku ? v.sku : null,
    imageUrl: v.media?.nodes?.[0]?.preview?.image?.url ?? null,
  }));
  const lowerTerm = term.toLowerCase();
  const chosen =
    variants.find((v) => v.sku?.toLowerCase() === lowerTerm) ??
    (variants.length === 1 ? variants[0] : undefined);
  return {
    productId: numericId(node.id),
    productTitle: node.title,
    imageUrl:
      chosen?.imageUrl ?? node.featuredMedia?.preview?.image?.url ?? null,
    variantId: chosen?.variantId ?? null,
    variantTitle: chosen?.variantTitle ?? null,
    sku: chosen?.sku ?? null,
    variants: chosen
      ? null
      : variants.map(({ variantId, variantTitle, sku }) => ({
          variantId,
          variantTitle,
          sku,
        })),
  };
}

function titleOrNull(title: string | null | undefined): string | null {
  return !title || title === "Default Title" ? null : title;
}

/**
 * The merchant's repair offerings: real Shopify products marked by a tag or
 * collection (Settings → Repair products), for the quote builder's picker and
 * the repair-service import (Rails `Parts::ServiceSync`). Ported from the
 * Shopify half of Rails `Repairs::ProductCatalog`; the settings are passed in.
 *
 * Variant and product ids are numeric strings, as RepairService stores them.
 */
import { cached, defaultShopifyCache, type ShopifyCache } from "./cache.server";
import { buildGid, numericId } from "./gid.server";
import {
  adminGraphql,
  errorSummary,
  type AdminGraphqlClient,
} from "./graphql.server";

const PRODUCT_FIELDS = `
  id title
  variants(first: 100) { nodes { id title price } }
`;

export const REPAIR_PRODUCTS_BY_TAG_QUERY = `#graphql
  query RepairProductsByTag($q: String!, $first: Int!, $after: String) {
    products(first: $first, after: $after, query: $q) {
      nodes { ${PRODUCT_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const REPAIR_PRODUCTS_BY_COLLECTION_QUERY = `#graphql
  query RepairProductsByCollection($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      products(first: $first, after: $after) {
        nodes { ${PRODUCT_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const REPAIR_VARIANT_QUERY = `#graphql
  query RepairVariant($id: ID!) {
    productVariant(id: $id) {
      id title price
      product { id title }
    }
  }
`;

export interface RepairProductSettings {
  /** "tag" (default) or "collection". */
  mode?: string | null;
  tag?: string | null;
  collectionId?: string | null;
}

export interface RepairVariant {
  productId: string;
  productTitle: string;
  variantId: string;
  variantTitle: string;
  /** Decimal string, e.g. "18.00". */
  price: string;
  /** "Sole replacement — Leather", or just the product title for a single variant. */
  label: string;
}

export const REPAIR_PRODUCTS_TTL_MS = 5 * 60 * 1000;
const PAGE_SIZE = 50;
const MAX_PAGES = 20;

/** "Sole replacement — Leather"; "Default Title" (one variant) is hidden. */
export function repairVariantLabel(productTitle: string, variantTitle: string) {
  return !variantTitle || variantTitle === "Default Title"
    ? productTitle
    : `${productTitle} — ${variantTitle}`;
}

function mode(settings: RepairProductSettings): "tag" | "collection" {
  return settings.mode === "collection" ? "collection" : "tag";
}

/** Settings → Repairs; "repair" when the merchant hasn't set one. */
export function repairTag(settings: RepairProductSettings): string {
  return settings.tag?.trim() || "repair";
}

export function repairProductsConfigured(settings: RepairProductSettings) {
  return mode(settings) === "tag"
    ? repairTag(settings) !== ""
    : Boolean(settings.collectionId?.trim());
}

/** The product search for a tag: `tag:'repair'`, quotes escaped. */
export function tagQuery(tag: string): string {
  return `tag:'${tag.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

interface ProductNode {
  id: string;
  title: string;
  variants: { nodes: { id: string; title: string; price: string }[] };
}

interface ProductPage {
  nodes: ProductNode[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/**
 * Every repair-product variant. Errors propagate (the repair-service import
 * must not switch services off because Shopify was unreachable).
 */
export async function fetchRepairVariants(
  client: AdminGraphqlClient,
  settings: RepairProductSettings,
): Promise<RepairVariant[]> {
  if (!repairProductsConfigured(settings)) return [];
  const products: ProductNode[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result: ProductPage | null = await fetchPage(client, settings, after);
    if (!result) break;
    products.push(...result.nodes);
    if (!result.pageInfo.hasNextPage) break;
    after = result.pageInfo.endCursor;
  }
  return products.flatMap((product) =>
    (product.variants?.nodes ?? []).map((variant) => ({
      productId: numericId(product.id),
      productTitle: product.title,
      variantId: numericId(variant.id),
      variantTitle: variant.title,
      price: variant.price,
      label: repairVariantLabel(product.title, variant.title),
    })),
  );
}

async function fetchPage(
  client: AdminGraphqlClient,
  settings: RepairProductSettings,
  after: string | null,
): Promise<ProductPage | null> {
  if (mode(settings) === "collection") {
    const data = await adminGraphql<{
      collection: { products: ProductPage } | null;
    }>(client, REPAIR_PRODUCTS_BY_COLLECTION_QUERY, {
      id: buildGid("Collection", settings.collectionId!.trim()),
      first: PAGE_SIZE,
      after,
    });
    return data.collection?.products ?? null;
  }
  const data = await adminGraphql<{ products: ProductPage }>(
    client,
    REPAIR_PRODUCTS_BY_TAG_QUERY,
    { q: tagQuery(repairTag(settings)), first: PAGE_SIZE, after },
  );
  return data.products;
}

/**
 * The picker's list: cached briefly so opening a ticket doesn't cost a
 * Shopify round-trip every time; a failure gives [] and isn't cached.
 */
export async function listRepairVariants(
  client: AdminGraphqlClient,
  settings: RepairProductSettings,
  options: {
    shopKey: string;
    cache?: ShopifyCache;
    logger?: Pick<Console, "error">;
  },
): Promise<RepairVariant[]> {
  if (!repairProductsConfigured(settings)) return [];
  const key = [
    "repair-variants",
    options.shopKey,
    mode(settings),
    repairTag(settings),
    settings.collectionId?.trim() ?? "",
  ].join(":");
  try {
    return (
      (await cached(
        options.cache ?? defaultShopifyCache,
        key,
        REPAIR_PRODUCTS_TTL_MS,
        () => fetchRepairVariants(client, settings),
      )) ?? []
    );
  } catch (error) {
    (options.logger ?? console).error(
      `[shopify/repair-products] list failed for ${options.shopKey}: ${errorSummary(error)}`,
    );
    return [];
  }
}

/**
 * One variant (numeric id), authoritatively: when staff add it to a quote,
 * title and price come from Shopify, not the submitted form. Null if unknown
 * or on failure.
 */
export async function fetchRepairVariant(
  client: AdminGraphqlClient,
  variantId: string,
  logger: Pick<Console, "error"> = console,
): Promise<RepairVariant | null> {
  try {
    const data = await adminGraphql<{
      productVariant: {
        id: string;
        title: string;
        price: string;
        product: { id: string; title: string } | null;
      } | null;
    }>(client, REPAIR_VARIANT_QUERY, {
      id: buildGid("ProductVariant", variantId),
    });
    const variant = data.productVariant;
    if (!variant?.product) return null;
    return {
      productId: numericId(variant.product.id),
      productTitle: variant.product.title,
      variantId: numericId(variant.id),
      variantTitle: variant.title,
      price: variant.price,
      label: repairVariantLabel(variant.product.title, variant.title),
    };
  } catch (error) {
    logger.error(
      `[shopify/repair-products] fetch variant failed: ${errorSummary(error)}`,
    );
    return null;
  }
}

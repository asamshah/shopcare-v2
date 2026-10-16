/**
 * Product details ShopCare decides things on:
 *
 * - ProductFacts (Rails `Warranty::ProductFacts`): tags, product type and
 *   collections, which warranty and Care eligibility are decided on, plus the
 *   variant title/SKU when a customer registers a product. Memoised per
 *   instance and cached briefly, since recording one order can ask about the
 *   same product several times. Lookups never throw: a failure is logged and
 *   gives null, and isn't cached.
 * - fetchVariantProperties (Rails `Parts::ItemProperties#fetch`): size and
 *   colour from the variant's options, and the model from a product
 *   metafield, which parts are matched on.
 */
import { cached, defaultShopifyCache, type ShopifyCache } from "./cache.server";
import { buildGid, numericId } from "./gid.server";
import {
  adminGraphql,
  errorSummary,
  type AdminGraphqlClient,
} from "./graphql.server";

const PRODUCT_FIELDS = `
  id title productType tags
  collections(first: 100) { nodes { id } }
`;

export const PRODUCT_FACTS_QUERY = `#graphql
  query ProductFacts($id: ID!) {
    product(id: $id) { ${PRODUCT_FIELDS} }
  }
`;

export const VARIANT_FACTS_QUERY = `#graphql
  query VariantFacts($id: ID!) {
    productVariant(id: $id) {
      id title sku
      product { ${PRODUCT_FIELDS} }
    }
  }
`;

export interface ProductFactsData {
  productId: string;
  title: string;
  productType: string;
  tags: string[];
  /** Numeric collection ids. */
  collectionIds: string[];
  variantId?: string;
  variantTitle?: string;
  sku?: string | null;
}

interface ProductNode {
  id: string;
  title: string;
  productType: string;
  tags: string[];
  collections: { nodes: { id: string }[] };
}

export const PRODUCT_FACTS_TTL_MS = 10 * 60 * 1000;

export interface ProductFactsOptions {
  /** Identifies the shop in cache keys (e.g. its domain). */
  shopKey: string;
  cache?: ShopifyCache;
  logger?: Pick<Console, "error">;
}

export class ProductFacts {
  private memo = new Map<string, Promise<ProductFactsData | null>>();
  private cache: ShopifyCache;
  private logger: Pick<Console, "error">;

  constructor(
    private client: AdminGraphqlClient,
    private options: ProductFactsOptions,
  ) {
    this.cache = options.cache ?? defaultShopifyCache;
    this.logger = options.logger ?? console;
  }

  /** Facts for a product (numeric id), or null if Shopify doesn't know it. */
  fetch(
    productId: string | null | undefined,
  ): Promise<ProductFactsData | null> {
    if (!productId) return Promise.resolve(null);
    const id = String(productId);
    let pending = this.memo.get(id);
    if (!pending) {
      pending = this.guard(() =>
        this.cachedLoad("product", id, async () => {
          const data = await adminGraphql<{ product: ProductNode | null }>(
            this.client,
            PRODUCT_FACTS_QUERY,
            { id: buildGid("Product", id) },
          );
          return data.product ? build(data.product) : null;
        }),
      );
      this.memo.set(id, pending);
    }
    return pending;
  }

  /** Facts for a variant (numeric id), including its title and SKU. */
  fetchVariant(
    variantId: string | null | undefined,
  ): Promise<ProductFactsData | null> {
    if (!variantId) return Promise.resolve(null);
    const id = String(variantId);
    return this.guard(() =>
      this.cachedLoad("variant", id, async () => {
        const data = await adminGraphql<{
          productVariant: {
            id: string;
            title: string;
            sku: string | null;
            product: ProductNode | null;
          } | null;
        }>(this.client, VARIANT_FACTS_QUERY, {
          id: buildGid("ProductVariant", id),
        });
        const variant = data.productVariant;
        if (!variant?.product) return null;
        return {
          ...build(variant.product),
          variantId: numericId(variant.id),
          variantTitle: variant.title,
          sku: variant.sku,
        };
      }),
    );
  }

  private cachedLoad(
    kind: string,
    id: string,
    load: () => Promise<ProductFactsData | null>,
  ) {
    const key = `product-facts:${this.options.shopKey}:${kind}:${id}`;
    return cached(this.cache, key, PRODUCT_FACTS_TTL_MS, load);
  }

  private async guard(
    load: () => Promise<ProductFactsData | null>,
  ): Promise<ProductFactsData | null> {
    try {
      return await load();
    } catch (error) {
      this.logger.error(
        `[shopify/product-facts] ${this.options.shopKey}: ${errorSummary(error)}`,
      );
      return null;
    }
  }
}

function build(product: ProductNode): ProductFactsData {
  return {
    productId: numericId(product.id),
    title: product.title,
    productType: product.productType,
    tags: product.tags ?? [],
    collectionIds: (product.collections?.nodes ?? []).map((c) =>
      numericId(c.id),
    ),
  };
}

export const VARIANT_PROPERTIES_QUERY = `#graphql
  query VariantProperties($id: ID!, $namespace: String!, $key: String!, $withMetafield: Boolean!) {
    productVariant(id: $id) {
      selectedOptions { name value }
      product {
        metafield(namespace: $namespace, key: $key) @include(if: $withMetafield) { value }
      }
    }
  }
`;

export interface VariantPropertySettings {
  /** "namespace.key" of the product metafield holding the model; blank to skip. */
  modelMetafield?: string | null;
  /** Option names to read the size from, comma-separated ("Size, UK Size"). */
  sizeOption?: string | null;
  /** Option names to read the colour from ("Colour, Color"). */
  colourOption?: string | null;
}

export interface VariantProperties {
  size?: string;
  colour?: string;
  sole_model?: string;
}

/**
 * The variant's size, colour and model (keys as Rails stored them on the
 * Item), with blanks left out; null if Shopify doesn't know the variant.
 * Errors propagate; the caller decides whether to retry.
 */
export async function fetchVariantProperties(
  client: AdminGraphqlClient,
  variantId: string,
  settings: VariantPropertySettings,
): Promise<VariantProperties | null> {
  const [namespace = "", key = ""] = splitOnce(
    settings.modelMetafield ?? "",
    ".",
  );
  const withMetafield = namespace !== "" && key !== "";
  const data = await adminGraphql<{
    productVariant: {
      selectedOptions: { name: string; value: string }[];
      product: { metafield?: { value: string } | null } | null;
    } | null;
  }>(client, VARIANT_PROPERTIES_QUERY, {
    id: buildGid("ProductVariant", variantId),
    namespace,
    key,
    withMetafield,
  });
  const variant = data.productVariant;
  if (!variant) return null;

  const options = new Map(
    (variant.selectedOptions ?? []).map((o) => [
      o.name.trim().toLowerCase(),
      o.value,
    ]),
  );
  const pick = (setting: string | null | undefined) =>
    (setting ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
      .map((name) => options.get(name))
      .find((value) => value !== undefined && value.trim() !== "");

  const properties: VariantProperties = {};
  const size = pick(settings.sizeOption);
  const colour = pick(settings.colourOption);
  const model = variant.product?.metafield?.value;
  if (size) properties.size = size;
  if (colour) properties.colour = colour;
  if (model && model.trim() !== "") properties.sole_model = model;
  return properties;
}

function splitOnce(value: string, separator: string): string[] {
  const index = value.indexOf(separator);
  return index < 0
    ? [value.trim()]
    : [value.slice(0, index).trim(), value.slice(index + 1).trim()];
}

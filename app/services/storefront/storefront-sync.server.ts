/**
 * Keeps the storefront working without calling the app where it can.
 *
 * The Care offer block on every product page used to ask the app (App Proxy
 * → /proxy/care_plans) which plans apply. Now the app publishes the shop's
 * active Care plans, with each plan's product rule, as an app-data metafield
 * (`app.metafields.shopcare.storefront`), and the block decides in Liquid:
 * no app call on a product page, so it costs nothing and keeps working if
 * the app is down. The proxy endpoint stays as the fallback (a store whose
 * metafield isn't published yet).
 *
 * Each sync first refreshes every active plan's price from its Care product
 * variant in Shopify. A plan copies the price when it's saved, so a price
 * changed later in Shopify would otherwise show the old one on the product
 * page (and on the cover) while the cart charges the new one.
 *
 * `storefrontChanged(shop)` is called after a merchant edit that changes what
 * the storefront shows (Care plans, product groups, settings, trade-in
 * programs) and on install; the daily prune also queues it for every shop, in
 * case an edit's sync was lost. It queues the `storefront-sync` job, which
 * republishes the metafield and clears the shop's CDN-cached App Proxy
 * responses (tag `shop:<domain>`), so edits show at once.
 */
import { Prisma, type ProductGroup, type Shop } from "@prisma/client";
import prisma from "../../db.server";
import type { JobPayload } from "../../jobs/registry.server";
import type { Db } from "../../lib/db-lock.server";
import { reportError } from "../../lib/errors.server";
import { activeCarePlans } from "../../models/care-plan.server";
import { groupTags, productGroupCollectionIds } from "../../models/product-group.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";
import { fetchRepairVariant } from "../../shopify/repair-products.server";
import { publishStorefrontData } from "../../shopify/storefront-data.server";
import { planJson, storefrontCurrency } from "./care-json.server";

/** Bump when the shape changes; the blocks fall back to the proxy for any other version. */
export const STOREFRONT_DATA_VERSION = 1;
/** Stands in for the product title in plan terms; the block puts the title in. */
export const PRODUCT_TOKEN = "{product}";

export type StorefrontRule =
  | { type: "all" }
  | { type: "collections"; collection_ids: string[] }
  | { type: "tags"; tags: string[] }
  | { type: "product_type"; product_type: string }
  | { type: "none" };

/** What Liquid checks against the product (same rules as productGroupMatches). */
function ruleFor(
  group: Pick<ProductGroup, "rule" | "collections" | "tags" | "productType"> | null,
): StorefrontRule {
  if (!group) return { type: "all" };
  switch (group.rule) {
    case "all":
      return { type: "all" };
    case "collections":
      return { type: "collections", collection_ids: productGroupCollectionIds(group) };
    case "tags":
      return { type: "tags", tags: groupTags(group).map((tag) => tag.toLowerCase()) };
    case "product_type":
      return { type: "product_type", product_type: (group.productType ?? "").toLowerCase() };
    default:
      return { type: "none" };
  }
}

export async function buildStorefrontData(shop: Pick<Shop, "id" | "settings">, db: Db = prisma) {
  const currency = storefrontCurrency(shop);
  const plans = await activeCarePlans(shop.id, db);
  return {
    v: STOREFRONT_DATA_VERSION,
    currency,
    plans: plans.map((plan) => ({
      ...planJson(plan, { currency, product: PRODUCT_TOKEN }),
      rule: ruleFor(plan.productGroup),
    })),
  };
}

export interface StorefrontSyncDeps {
  db?: typeof prisma;
  /** The shop's offline Admin client; null when it has none (not installed). */
  client?: (shop: Shop) => Promise<AdminGraphqlClient | null>;
  /** Clears the shop's CDN-cached proxy responses (no-op off Netlify). */
  purge?: (tags: string[]) => Promise<void>;
}

let configured: StorefrontSyncDeps = {};

/** Overrides the job's dependencies (tests); {} goes back to the defaults. */
export function setStorefrontSyncDeps(deps: StorefrontSyncDeps) {
  configured = deps;
}

async function offlineClient(shop: Shop): Promise<AdminGraphqlClient | null> {
  if (process.env.VITEST) return null; // tests pass a client
  const session = await prisma.session.findFirst({ where: { shop: shop.shopifyDomain, isOnline: false } });
  if (!session) return null;
  const { adminClientForShop } = await import("../../shopify/client.server");
  return adminClientForShop(shop.shopifyDomain);
}

async function netlifyPurge(tags: string[]): Promise<void> {
  if (!("Netlify" in globalThis) && process.env.NETLIFY !== "true") return;
  const { purgeCache } = await import("@netlify/functions");
  await purgeCache({ tags });
}

/** The `storefront-sync` job: republish the metafield, then clear the cache. Throws to retry. */
export async function syncStorefront(shopId: number, deps: StorefrontSyncDeps = configured): Promise<"synced" | "skipped"> {
  const db = deps.db ?? prisma;
  const shop = await db.shop.findUnique({ where: { id: shopId } });
  if (!shop || shop.uninstalledAt) return "skipped";
  const client = await (deps.client ?? offlineClient)(shop);
  if (!client) return "skipped";

  await refreshPlanPrices(shop.id, client, db);
  await publishStorefrontData(client, await buildStorefrontData(shop, db));
  try {
    await (deps.purge ?? netlifyPurge)([`shop:${shop.shopifyDomain}`]);
  } catch (error) {
    // Not worth a retry (that would republish too): cached responses expire within minutes.
    await reportError(error, { area: "storefront-sync", step: "purge", shop: shop.shopifyDomain });
  }
  return "synced";
}

/**
 * Copies each active plan's Care variant price from Shopify onto the plan.
 * A variant Shopify can't find (deleted) keeps its plan's price. Returns how
 * many plans changed.
 */
export async function refreshPlanPrices(
  shopId: number,
  client: AdminGraphqlClient,
  db: typeof prisma = prisma,
): Promise<number> {
  let changed = 0;
  for (const plan of await activeCarePlans(shopId, db)) {
    const variant = await fetchRepairVariant(client, plan.shopifyVariantId);
    if (!variant) continue;
    const price = new Prisma.Decimal(variant.price);
    if (price.equals(plan.price)) continue;
    await db.carePlan.update({ where: { id: plan.id }, data: { price } });
    console.info(`[storefront-sync] plan ${plan.id} price ${plan.price.toFixed(2)} → ${price.toFixed(2)} (from Shopify)`);
    changed++;
  }
  return changed;
}

export async function storefrontSyncJob(payload: JobPayload): Promise<void> {
  const shopId = Number(payload.shopId);
  if (!Number.isSafeInteger(shopId)) return;
  const result = await syncStorefront(shopId);
  console.info(`[job:storefront-sync] shop=${shopId} ${result}`);
}

/**
 * After a merchant edit: queue the sync. Never throws, so a save can't fail
 * because of it (the daily resync catches up).
 */
export async function storefrontChanged(
  shop: Pick<Shop, "id" | "shopifyDomain">,
  enqueue?: (name: "storefront-sync", payload: JobPayload) => Promise<void>,
): Promise<void> {
  try {
    const run = enqueue ?? (await import("../../lib/background.server")).enqueue;
    await run("storefront-sync", { shopId: shop.id });
  } catch (error) {
    await reportError(error, { area: "storefront-sync", step: "enqueue", shop: shop.shopifyDomain });
  }
}

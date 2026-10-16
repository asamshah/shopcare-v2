/**
 * Backfills Items (and their warranty / Care cover) from the shop's recent
 * paid orders, after install. Port of ImportOrdersJob +
 * Items::OrderImporter#import_recent, made resumable for Netlify's 15-minute
 * background limit: each run records up to PAGES_PER_RUN pages of orders,
 * saves the cursor in `settings.items_import` and enqueues itself for the
 * next page. Recording is idempotent per order line unit, so a retried run
 * repeats nothing. `read_orders` only reaches back 60 days until
 * `read_all_orders` is approved (docs/GOING-LIVE.md).
 *
 * Status in settings.items_import: { status: queued|running|finished|failed,
 * at, created, cursor?, since }.
 */
import type { Prisma, Shop } from "@prisma/client";
import prisma from "../db.server";
import { settingsOf } from "../models/shop.server";
import { BACKFILL_DAYS } from "../services/items/order-importer.server";
import { ItemRecorder } from "../services/items/recorder.server";
import type { AdminGraphqlClient } from "../shopify/graphql.server";
import { fetchPaidOrdersPage } from "../shopify/orders.server";
import { ProductFactsLoader } from "../shopify/product-facts.server";
import type { JobPayload } from "./registry.server";

export const PAGES_PER_RUN = 20;

export interface ImportOrdersDeps {
  db?: typeof prisma;
  client?: (shop: Shop) => Promise<AdminGraphqlClient>;
  enqueue?: (name: "import-orders", payload: JobPayload) => Promise<void>;
  now?: Date;
  pagesPerRun?: number;
}

let configured: ImportOrdersDeps = {};
export function setImportOrdersDeps(deps: ImportOrdersDeps) {
  configured = deps;
}

async function recordStatus(
  db: typeof prisma,
  shopId: number,
  status: Record<string, unknown>,
  now: Date,
) {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } });
  const previous = (settingsOf(shop).items_import ?? {}) as Record<string, unknown>;
  await db.shop.update({
    where: { id: shopId },
    data: {
      settings: {
        ...settingsOf(shop),
        items_import: { ...previous, ...status, at: now.toISOString() },
      } as Prisma.InputJsonValue,
    },
  });
}

/** Starts the backfill once per shop (Rails AfterAuthenticateJob). */
export async function queueOrderImport(
  shop: Pick<Shop, "id" | "settings">,
  {
    db = prisma,
    enqueue,
    now = new Date(),
  }: Pick<ImportOrdersDeps, "db" | "enqueue" | "now"> = {},
): Promise<boolean> {
  if (settingsOf(shop).items_import) return false;
  await recordStatus(db, shop.id, { status: "queued", created: 0 }, now);
  const run = enqueue ?? (await import("../lib/background.server")).enqueue;
  await run("import-orders", { shopId: shop.id });
  return true;
}

export async function importOrdersJob(payload: JobPayload): Promise<void> {
  const db = configured.db ?? prisma;
  const now = configured.now ?? new Date();
  const shopId = Number(payload.shopId);
  const shop = Number.isInteger(shopId)
    ? await db.shop.findUnique({ where: { id: shopId } })
    : null;
  if (!shop || shop.uninstalledAt) return;

  const state = (settingsOf(shop).items_import ?? {}) as Record<string, unknown>;
  const cursor = typeof payload.cursor === "string" ? payload.cursor : null;
  // Same window for every page of one import.
  const since =
    cursor && typeof state.since === "string"
      ? new Date(state.since)
      : new Date(now.getTime() - BACKFILL_DAYS * 86_400_000);
  let created = cursor ? Number(state.created) || 0 : 0;

  try {
    await recordStatus(db, shop.id, { status: "running", since: since.toISOString(), created }, now);
    const client = await (configured.client ??
      (async (s: Shop) =>
        (await import("../shopify/client.server")).adminClientForShop(s.shopifyDomain)))(shop);
    const recorder = new ItemRecorder(shop, {
      db,
      facts: new ProductFactsLoader(client, { shopKey: shop.shopifyDomain }),
    });
    let after = cursor;
    for (let page = 0; page < (configured.pagesPerRun ?? PAGES_PER_RUN); page++) {
      const result = await fetchPaidOrdersPage(client, since, after);
      for (const order of result.orders) created += (await recorder.record(order)).length;
      after = result.nextCursor;
      if (!after) {
        await recordStatus(db, shop.id, { status: "finished", created, cursor: null }, now);
        return;
      }
    }
    await recordStatus(db, shop.id, { status: "running", created, cursor: after }, now);
    const run = configured.enqueue ?? (await import("../lib/background.server")).enqueue;
    await run("import-orders", { shopId: shop.id, cursor: after });
  } catch (error) {
    await recordStatus(db, shop.id, { status: "failed", created }, now);
    throw error;
  }
}

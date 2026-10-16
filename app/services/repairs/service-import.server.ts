/**
 * Mirrors the merchant's Shopify repair products (Settings → Repairs) as
 * RepairServices: new variants are added, titles and prices refreshed, and
 * services whose product is gone are switched off (their recipes are kept).
 * Port of Parts::ServiceSync (used by Repair services → Sync / Import from a
 * collection, and the setup wizard's step 2).
 */
import type { Shop } from "@prisma/client";
import prisma from "../../db.server";
import { type Db, inTransaction } from "../../lib/db-lock.server";
import { createRepairService, updateRepairService } from "../../models/repair-service.server";
import { settingsOf } from "../../models/shop.server";
import { jsonObject } from "../../models/validation.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";
import {
  fetchRepairVariants,
  repairProductsConfigured,
  type RepairProductSettings,
  type RepairVariant,
} from "../../shopify/repair-products.server";

export interface SyncCounts {
  added: number;
  updated: number;
  deactivated: number;
}

/** The catalogue a sync reads; tests pass a fake. */
export interface RepairCatalog {
  configured: boolean;
  variants(): Promise<RepairVariant[]>;
}

/** Settings → Repairs as repair-products.server.ts wants it. */
export function repairProductSettings(shop: Pick<Shop, "settings">): RepairProductSettings {
  const raw = jsonObject(settingsOf(shop).repair_products as never);
  const text = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? null : String(v));
  return { mode: text(raw.mode), tag: text(raw.tag), collectionId: text(raw.collection_id) };
}

export function shopifyRepairCatalog(shop: Pick<Shop, "settings">, client: AdminGraphqlClient): RepairCatalog {
  const settings = repairProductSettings(shop);
  return {
    configured: repairProductsConfigured(settings),
    variants: () => fetchRepairVariants(client, settings),
  };
}

/** { added, updated, deactivated }, or null if the catalogue isn't set up. Shopify errors propagate. */
export async function importRepairServices(
  shopId: number,
  catalog: RepairCatalog,
  db: Db = prisma,
): Promise<SyncCounts | null> {
  if (!catalog.configured) return null;
  const variants = await catalog.variants();
  return inTransaction(db, async (tx) => {
    const counts: SyncCounts = { added: 0, updated: 0, deactivated: 0 };
    for (const variant of variants) {
      const existing = await tx.repairService.findFirst({
        where: { shopId, shopifyVariantId: variant.variantId },
      });
      const data = {
        title: variant.label,
        shopifyProductId: variant.productId,
        price: variant.price,
        active: true,
      };
      if (existing) {
        await updateRepairService(existing.id, data, tx);
        counts.updated += 1;
      } else {
        await createRepairService({ ...data, shopId, shopifyVariantId: variant.variantId }, tx);
        counts.added += 1;
      }
    }
    const stale = await tx.repairService.updateMany({
      where: { shopId, active: true, shopifyVariantId: { notIn: variants.map((v) => v.variantId) } },
      data: { active: false },
    });
    counts.deactivated = stale.count;
    return counts;
  });
}

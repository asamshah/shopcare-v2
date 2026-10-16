import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { getStorage, type FileStorage } from "../lib/storage.server";
import { settingsOf } from "../models/shop.server";
import { EXPORT_RETENTION_DAYS } from "../services/gdpr/customer-export.server";
import { PostgresCache } from "../lib/postgres-cache.server";
import {
  postgresThrottleStore,
  THROTTLE_RETENTION_MS,
} from "../lib/proxy-throttling.server";

/**
 * Deletes rows that only grow: App Proxy throttle counters whose window is
 * over a day old, and expired shared-cache entries. Run daily by
 * netlify/functions/daily-prune.mts. Idempotent.
 */
export async function pruneStaleRows(
  now: Date = new Date(),
  db = prisma,
  storage: FileStorage = getStorage(),
): Promise<{ throttles: number; cacheEntries: number; exports: number }> {
  const throttles = await postgresThrottleStore(db).prune(
    new Date(now.getTime() - THROTTLE_RETENTION_MS),
  );
  const cacheEntries = await new PostgresCache(db, () => now).prune();
  const exports = await pruneGdprExports(now, db, storage);
  return { throttles, cacheEntries, exports };
}

interface ExportEntry {
  key: string;
  created_at?: string;
}

export async function pruneGdprExports(
  now: Date,
  db = prisma,
  storage: FileStorage = getStorage(),
): Promise<number> {
  const cutoff = now.getTime() - EXPORT_RETENTION_DAYS * 86_400_000;
  // Few shops, and only those with exports are touched.
  const shops = await db.shop.findMany();
  let removed = 0;
  for (const shop of shops) {
    const entries = (settingsOf(shop).gdpr_exports as ExportEntry[] | undefined) ?? [];
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const old = entries.filter((e) => !e.created_at || Date.parse(e.created_at) < cutoff);
    if (old.length === 0) continue;
    for (const entry of old) {
      await storage.delete(entry.key).catch(() => {});
      removed++;
    }
    await db.shop.update({
      where: { id: shop.id },
      data: {
        settings: {
          ...settingsOf(shop),
          gdpr_exports: entries.filter((e) => !old.includes(e)),
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }
  return removed;
}

export async function dailyPruneJob(): Promise<void> {
  const removed = await pruneStaleRows();
  console.info(
    `[job:daily-prune] removed ${removed.throttles} throttle rows, ${removed.cacheEntries} cache entries, ${removed.exports} GDPR exports`,
  );
}

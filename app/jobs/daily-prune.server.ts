import prisma from "../db.server";
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
): Promise<{ throttles: number; cacheEntries: number }> {
  const throttles = await postgresThrottleStore(db).prune(
    new Date(now.getTime() - THROTTLE_RETENTION_MS),
  );
  const cacheEntries = await new PostgresCache(db, () => now).prune();
  return { throttles, cacheEntries };
}

export async function dailyPruneJob(): Promise<void> {
  const removed = await pruneStaleRows();
  console.info(
    `[job:daily-prune] removed ${removed.throttles} throttle rows, ${removed.cacheEntries} cache entries`,
  );
}

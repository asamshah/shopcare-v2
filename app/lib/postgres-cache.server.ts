/**
 * The shared TTL cache for Shopify reads (product facts, catalogue search,
 * repair products), in the `cache_entries` table. Netlify function instances
 * share no memory, so this is what makes a cached read count across
 * instances. Values are JSON; expired rows are ignored on read and deleted by
 * the daily prune (netlify/functions/daily-prune.mts).
 *
 * A cache must never break the read it speeds up: database errors are logged
 * and treated as a miss (get) or skipped (set).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { ShopifyCache } from "../shopify/cache.server";

type CacheDb = Pick<PrismaClient, "cacheEntry">;

export class PostgresCache implements ShopifyCache {
  constructor(
    private db: CacheDb,
    private now: () => Date = () => new Date(),
    private logger: Pick<Console, "warn"> = console,
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const row = await this.db.cacheEntry.findUnique({ where: { key } });
      if (!row || row.expiresAt <= this.now()) return undefined;
      return row.value as T;
    } catch (error) {
      this.logger.warn(`[cache] get ${key} failed: ${String(error)}`);
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const expiresAt = new Date(this.now().getTime() + ttlMs);
    const json = value as unknown as Prisma.InputJsonValue;
    try {
      await this.db.cacheEntry.upsert({
        where: { key },
        create: { key, value: json, expiresAt },
        update: { value: json, expiresAt },
      });
    } catch (error) {
      this.logger.warn(`[cache] set ${key} failed: ${String(error)}`);
    }
  }

  /** Deletes expired rows; returns how many. */
  async prune(): Promise<number> {
    const { count } = await this.db.cacheEntry.deleteMany({
      where: { expiresAt: { lte: this.now() } },
    });
    return count;
  }
}

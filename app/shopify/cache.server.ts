/**
 * A small TTL cache for Shopify reads that Rails kept in `Rails.cache`
 * (product facts, catalogue search, repair products).
 *
 * Netlify function instances share nothing, so the default is per instance:
 * it saves repeat calls within one warm instance (e.g. recording an order that
 * asks about the same product several times) and nothing more. Callers that
 * need a shared cache can pass any `ShopifyCache` (Postgres, Netlify Blobs).
 * Failures are never cached: only values a loader returns are stored, and
 * `null` is skipped like Rails' `skip_nil: true`.
 */

export interface ShopifyCache {
  get<T>(key: string): Promise<T | undefined> | T | undefined;
  set<T>(key: string, value: T, ttlMs: number): Promise<void> | void;
}

export class MemoryCache implements ShopifyCache {
  private entries = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(
    private maxEntries = 500,
    private now: () => number = Date.now,
  ) {}

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    // Maps iterate in insertion order: drop the oldest beyond the cap.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Shared by default within one function instance. */
export const defaultShopifyCache = new MemoryCache();

/** Returns the cached value, or loads, stores (unless null) and returns it. */
export async function cached<T>(
  cache: ShopifyCache,
  key: string,
  ttlMs: number,
  load: () => Promise<T | null>,
): Promise<T | null> {
  const hit = await cache.get<T>(key);
  if (hit !== undefined) return hit;
  const value = await load();
  if (value !== null && value !== undefined) await cache.set(key, value, ttlMs);
  return value;
}

/**
 * A minimal fixed-window rate limit for App Proxy endpoints (port of Rails
 * `ProxyThrottling`). Two counters per window: one per shop + visitor IP, and
 * a ceiling per shop. Once either passes its limit the request gets a 429.
 *
 * Netlify Function instances share no memory, so outside tests the counts are
 * in Postgres (`postgresThrottleStore`, table `proxy_throttles`, pruned daily
 * by netlify/functions/daily-prune.mts). `memoryThrottleStore` is for unit
 * tests only: on Netlify it would count per instance.
 */
import type { PrismaClient } from "@prisma/client";
import prisma from "../db.server";

export interface ThrottleStore {
  /**
   * Adds one to `key` for the window starting at `windowStart` and returns the
   * new count. A newer window resets the count to 1. Must be atomic.
   */
  increment(key: string, windowStart: Date): Promise<number>;
  /** Deletes counters whose window started before `before`. */
  prune(before: Date): Promise<number>;
}

export function memoryThrottleStore(): ThrottleStore & {
  set(key: string, windowStart: Date, count: number): void;
} {
  const rows = new Map<string, { windowStart: number; count: number }>();
  return {
    async increment(key, windowStart) {
      const start = windowStart.getTime();
      const row = rows.get(key);
      const next =
        row && row.windowStart >= start
          ? { windowStart: row.windowStart, count: row.count + 1 }
          : { windowStart: start, count: 1 };
      rows.set(key, next);
      return next.count;
    },
    async prune(before) {
      let removed = 0;
      for (const [key, row] of rows) {
        if (row.windowStart < before.getTime()) {
          rows.delete(key);
          removed++;
        }
      }
      return removed;
    },
    /** Test helper: preset a counter (Rails tests wrote straight to the cache). */
    set(key, windowStart, count) {
      rows.set(key, { windowStart: windowStart.getTime(), count });
    },
  };
}

/**
 * One row per (endpoint, shop, scope); the upsert increments it in place, or
 * resets it when a newer window starts. A request that arrives late for an
 * older window just counts against the current one.
 */
export function postgresThrottleStore(
  db: Pick<PrismaClient, "$queryRaw" | "$executeRaw">,
): ThrottleStore {
  return {
    async increment(key, windowStart) {
      const rows = await db.$queryRaw<{ count: number }[]>`
        INSERT INTO proxy_throttles (key, window_start, count)
        VALUES (${key}, ${windowStart}, 1)
        ON CONFLICT (key) DO UPDATE SET
          count = CASE
            WHEN proxy_throttles.window_start >= EXCLUDED.window_start
              THEN proxy_throttles.count + 1
            ELSE 1
          END,
          window_start = GREATEST(proxy_throttles.window_start, EXCLUDED.window_start)
        RETURNING count`;
      return Number(rows[0]?.count ?? 0);
    },
    async prune(before) {
      return db.$executeRaw`DELETE FROM proxy_throttles WHERE window_start < ${before}`;
    },
  };
}

/** Postgres everywhere except under Vitest. */
export function defaultThrottleStore(): ThrottleStore {
  return process.env.VITEST ? memoryThrottleStore() : postgresThrottleStore(prisma);
}

/** Throttle rows older than this are pruned (no window is longer than a day). */
export const THROTTLE_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface ThrottleLimits {
  /** Endpoint name, part of the counter key (e.g. "catalog", "order_lookup"). */
  name: string;
  perIp: number;
  perShop: number;
  periodSeconds: number;
  /** Shown to the visitor in the 429 body. */
  message?: string;
}

export const DEFAULT_THROTTLE_MESSAGE =
  "Too many searches. Please wait a minute and try again.";

/**
 * The visitor's IP. App Proxy requests reach Netlify from Shopify's servers,
 * so the connecting IP (`x-nf-client-connection-ip`) is Shopify's, shared by
 * every shopper; Shopify documents the visitor's IP as the first
 * X-Forwarded-For entry. That header isn't signed, so a visitor replaying a
 * signed URL straight to Netlify could vary it; the per-shop ceiling still
 * holds (same trade-off as Rails). The Netlify header is the fallback.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers
    .get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  return (
    forwarded ||
    request.headers.get("x-nf-client-connection-ip")?.trim() ||
    "unknown"
  );
}

export function throttleKey(name: string, shop: string, scope: string): string {
  return `${name}/${shop}/${scope}`;
}

export function windowStartFor(now: Date, periodSeconds: number): Date {
  const period = periodSeconds * 1000;
  return new Date(Math.floor(now.getTime() / period) * period);
}

/**
 * Counts this request; returns a 429 Response once either counter passes its
 * limit, or null to carry on. Like Rails, the shop counter isn't touched when
 * the per-IP one is already over.
 */
export async function throttle(
  request: Request,
  shop: string,
  limits: ThrottleLimits,
  { store, now = new Date() }: { store: ThrottleStore; now?: Date },
): Promise<Response | null> {
  const windowStart = windowStartFor(now, limits.periodSeconds);
  const counters: [string, number][] = [
    [`ip:${clientIp(request)}`, limits.perIp],
    ["shop", limits.perShop],
  ];
  for (const [scope, limit] of counters) {
    const count = await store.increment(
      throttleKey(limits.name, shop, scope),
      windowStart,
    );
    if (count > limit) {
      const retryAfter = Math.max(
        1,
        Math.ceil(
          (windowStart.getTime() +
            limits.periodSeconds * 1000 -
            now.getTime()) /
            1000,
        ),
      );
      return new Response(
        JSON.stringify({
          ok: false,
          error: limits.message ?? DEFAULT_THROTTLE_MESSAGE,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "private, no-store",
            "Netlify-CDN-Cache-Control": "no-store",
            "Retry-After": String(retryAfter),
          },
        },
      );
    }
  }
  return null;
}

/** The Postgres shared cache and the daily prune job. */
import { describe, expect, it, vi } from "vitest";
import prisma from "../../../app/db.server";
import { pruneStaleRows } from "../../../app/jobs/daily-prune.server";
import { runJob } from "../../../app/jobs/registry.server";
import { PostgresCache } from "../../../app/lib/postgres-cache.server";
import { postgresThrottleStore } from "../../../app/lib/proxy-throttling.server";
import { cached } from "../../../app/shopify/cache.server";

const t0 = new Date("2026-10-16T12:00:00Z");

describe("PostgresCache", () => {
  it("stores JSON with a TTL, shared across instances", async () => {
    let now = t0;
    const a = new PostgresCache(prisma, () => now);
    const b = new PostgresCache(prisma, () => now);
    await a.set("product-facts:acme:product:1", { tags: ["boot"], n: 1 }, 60_000);

    expect(await b.get("product-facts:acme:product:1")).toEqual({ tags: ["boot"], n: 1 });
    now = new Date(t0.getTime() + 60_000);
    expect(await b.get("product-facts:acme:product:1")).toBeUndefined();

    await a.set("product-facts:acme:product:1", { tags: [] }, 60_000);
    expect(await b.get("product-facts:acme:product:1")).toEqual({ tags: [] });
  });

  it("works with cached(): loads once, skips null", async () => {
    const cache = new PostgresCache(prisma, () => t0);
    const load = vi.fn(async () => ({ id: "1" }));
    await cached(cache, "k", 60_000, load);
    await cached(cache, "k", 60_000, load);
    expect(load).toHaveBeenCalledTimes(1);

    await cached(cache, "none", 60_000, async () => null);
    expect(await prisma.cacheEntry.count({ where: { key: "none" } })).toBe(0);
  });

  it("treats a database failure as a miss instead of failing the read", async () => {
    const warn = vi.fn();
    const broken = {
      cacheEntry: {
        findUnique: async () => {
          throw new Error("db down");
        },
        upsert: async () => {
          throw new Error("db down");
        },
      },
    } as unknown as typeof prisma;
    const cache = new PostgresCache(broken, () => t0, { warn });
    expect(await cache.get("k")).toBeUndefined();
    await cache.set("k", 1, 1000);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("daily prune", () => {
  it("drops throttle rows older than a day and expired cache entries", async () => {
    const throttles = postgresThrottleStore(prisma);
    await throttles.increment("ping/acme/shop", new Date(t0.getTime() - 25 * 3600_000));
    await throttles.increment("ping/acme/ip:1", new Date(t0.getTime() - 3600_000));
    const cache = new PostgresCache(prisma, () => t0);
    await cache.set("old", 1, -1);
    await cache.set("fresh", 1, 60_000);

    expect(await pruneStaleRows(t0)).toEqual({ throttles: 1, cacheEntries: 1 });
    expect((await prisma.proxyThrottle.findMany()).map((r) => r.key)).toEqual(["ping/acme/ip:1"]);
    expect((await prisma.cacheEntry.findMany()).map((r) => r.key)).toEqual(["fresh"]);
  });

  it("is registered as the daily-prune job", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await runJob("daily-prune", {});
    expect(info).toHaveBeenCalledWith(expect.stringContaining("[job:daily-prune] removed"));
    info.mockRestore();
  });
});

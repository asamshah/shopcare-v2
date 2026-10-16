/**
 * postgresThrottleStore against real Postgres (table proxy_throttles, from
 * the 20261016165420_proxy_throttles_and_cache migration).
 */
import { describe, expect, it } from "vitest";
import prisma from "../../app/db.server";
import {
  postgresThrottleStore,
  throttle,
  throttleKey,
  windowStartFor,
} from "../../app/lib/proxy-throttling.server";

const store = () => postgresThrottleStore(prisma);
const w1 = new Date("2026-10-16T12:00:00Z");
const w2 = new Date("2026-10-16T12:10:00Z");

describe("postgresThrottleStore", () => {
  it("counts within a window and resets in a newer one", async () => {
    const s = store();
    expect(await s.increment("k", w1)).toBe(1);
    expect(await s.increment("k", w1)).toBe(2);
    expect(await s.increment("k", w2)).toBe(1);
    // A straggler from the older window counts against the current one.
    expect(await s.increment("k", w1)).toBe(2);
  });

  it("is atomic under concurrent requests", async () => {
    const s = store();
    const counts = await Promise.all(
      Array.from({ length: 25 }, () => s.increment("burst", w1)),
    );
    expect(counts.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
  });

  it("prunes old windows", async () => {
    const s = store();
    await s.increment("old", w1);
    await s.increment("new", w2);
    expect(await s.prune(w2)).toBe(1);
  });

  it("drives throttle(): per visitor, then the shop ceiling", async () => {
    const s = store();
    const shop = "find-test.myshopify.com";
    const limits = {
      name: "order_lookup",
      perIp: 2,
      perShop: 3,
      periodSeconds: 600,
    };
    const now = new Date("2026-10-16T12:03:00Z");
    const from = (ip: string) =>
      new Request("https://shopcare.test/proxy/order_lookup", {
        headers: { "x-forwarded-for": ip },
      });
    const run = (ip: string) =>
      throttle(from(ip), shop, limits, { store: s, now });

    expect(await run("203.0.113.5")).toBeNull();
    expect(await run("203.0.113.5")).toBeNull();
    expect((await run("203.0.113.5"))?.status).toBe(429);
    expect(await run("198.51.100.7")).toBeNull(); // shop count is now 3
    expect((await run("192.0.2.1"))?.status).toBe(429);
    const [row] = await prisma.$queryRaw<
      { count: number; window_start: Date }[]
    >`
      SELECT count, window_start FROM proxy_throttles
      WHERE key = ${throttleKey("order_lookup", shop, "shop")}`;
    expect(row.count).toBe(4);
    expect(row.window_start.toISOString()).toBe(
      windowStartFor(now, 600).toISOString(),
    );
  });
});

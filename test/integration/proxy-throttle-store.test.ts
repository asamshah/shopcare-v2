/**
 * postgresThrottleStore against real Postgres. The proxy_throttles table is
 * pending (prisma/pending/proxy_throttles.sql), so this file creates it from
 * that SQL when the migrations haven't, and drops only what it created.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../app/db.server";
import {
  postgresThrottleStore,
  throttle,
  throttleKey,
  windowStartFor,
} from "../../app/lib/proxy-throttling.server";

let created = false;

beforeAll(async () => {
  const [{ exists }] = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT to_regclass('proxy_throttles') IS NOT NULL AS exists`;
  if (exists) return;
  const sql = readFileSync("prisma/pending/proxy_throttles.sql", "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n");
  for (const statement of sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    await prisma.$executeRawUnsafe(statement);
  }
  created = true;
});

afterAll(async () => {
  if (created) await prisma.$executeRawUnsafe(`DROP TABLE proxy_throttles`);
});

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

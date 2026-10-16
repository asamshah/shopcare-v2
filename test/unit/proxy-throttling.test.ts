/**
 * Port of the rate-limit case in Rails test/integration/proxy_find_product_test.rb,
 * plus the IP source and window maths.
 */
import { describe, expect, it } from "vitest";
import {
  clientIp,
  memoryThrottleStore,
  throttle,
  throttleKey,
  windowStartFor,
  DEFAULT_THROTTLE_MESSAGE,
} from "../../app/lib/proxy-throttling.server";

const shop = "find-test.myshopify.com";
const limits = {
  name: "order_lookup",
  perIp: 10,
  perShop: 300,
  periodSeconds: 600,
};
const now = new Date("2026-10-16T12:03:20Z");
const from = (ip: string, nfIp = "23.227.38.1") =>
  new Request("https://shopcare.test/proxy/order_lookup", {
    headers: {
      "x-forwarded-for": `${ip}, 10.0.0.1`,
      "x-nf-client-connection-ip": nfIp,
    },
  });

describe("clientIp", () => {
  it("uses the first X-Forwarded-For entry (the shopper, as Shopify reports it)", () => {
    expect(clientIp(from("203.0.113.5"))).toBe("203.0.113.5");
  });

  it("falls back to Netlify's connecting IP, then 'unknown'", () => {
    const nfOnly = new Request("https://x.test", {
      headers: { "x-nf-client-connection-ip": "198.51.100.9" },
    });
    expect(clientIp(nfOnly)).toBe("198.51.100.9");
    expect(clientIp(new Request("https://x.test"))).toBe("unknown");
  });
});

describe("windowStartFor", () => {
  it("floors to the fixed window", () => {
    expect(windowStartFor(now, 600).toISOString()).toBe(
      "2026-10-16T12:00:00.000Z",
    );
    expect(windowStartFor(now, 60).toISOString()).toBe(
      "2026-10-16T12:03:00.000Z",
    );
  });
});

describe("throttle", () => {
  it("limits per visitor, then per shop", async () => {
    const store = memoryThrottleStore();
    const run = (ip: string) =>
      throttle(from(ip), shop, limits, { store, now });

    for (let i = 0; i < 10; i++) expect(await run("203.0.113.5")).toBeNull();
    const limited = await run("203.0.113.5");
    expect(limited?.status).toBe(429);
    expect(await limited?.json()).toEqual({
      ok: false,
      error: DEFAULT_THROTTLE_MESSAGE,
    });
    expect(limited?.headers.get("Cache-Control")).toBe("private, no-store");
    expect(limited?.headers.get("Retry-After")).toBe("400");

    expect(await run("198.51.100.7")).toBeNull(); // another visitor isn't blocked

    store.set(
      throttleKey("order_lookup", shop, "shop"),
      windowStartFor(now, 600),
      300,
    );
    expect((await run("192.0.2.1"))?.status).toBe(429);
  });

  it("starts counting again in the next window", async () => {
    const store = memoryThrottleStore();
    const tight = { ...limits, perIp: 1 };
    expect(
      await throttle(from("203.0.113.5"), shop, tight, { store, now }),
    ).toBeNull();
    expect(
      (await throttle(from("203.0.113.5"), shop, tight, { store, now }))
        ?.status,
    ).toBe(429);
    const later = new Date(now.getTime() + 600_000);
    expect(
      await throttle(from("203.0.113.5"), shop, tight, { store, now: later }),
    ).toBeNull();
  });

  it("keeps shops and endpoints apart, and uses a custom message", async () => {
    const store = memoryThrottleStore();
    const tight = { ...limits, perIp: 1, message: "Slow down." };
    await throttle(from("203.0.113.5"), shop, tight, { store, now });
    expect(
      await throttle(from("203.0.113.5"), "other.myshopify.com", tight, {
        store,
        now,
      }),
    ).toBeNull();
    expect(
      await throttle(
        from("203.0.113.5"),
        shop,
        { ...tight, name: "catalog" },
        { store, now },
      ),
    ).toBeNull();
    const limited = await throttle(from("203.0.113.5"), shop, tight, {
      store,
      now,
    });
    expect(await limited?.json()).toEqual({ ok: false, error: "Slow down." });
  });

  it("prunes old windows", async () => {
    const store = memoryThrottleStore();
    await store.increment("a", new Date("2026-10-15T00:00:00Z"));
    await store.increment("b", now);
    expect(await store.prune(new Date("2026-10-16T00:00:00Z"))).toBe(1);
  });
});

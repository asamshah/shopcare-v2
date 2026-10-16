/**
 * The App Proxy context and route wrapper with the signature check stubbed
 * (test/integration/proxy-ping.test.ts runs the real one). Customer cases are
 * ported from Rails test/integration/proxy_orders_test.rb.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authenticateProxy,
  configureAppProxy,
  proxyRoute,
  type AppProxyDeps,
} from "../../app/lib/app-proxy.server";
import { memoryThrottleStore } from "../../app/lib/proxy-throttling.server";
import { signCustomerToken } from "../../app/lib/customer-token.server";

const shop = "orders-test.myshopify.com";
const key = "k".repeat(64);
const now = new Date("2026-10-16T12:00:00Z");
const ts = String(Math.floor(now.getTime() / 1000));

function deps(overrides: Partial<AppProxyDeps> = {}): AppProxyDeps {
  return {
    authenticate: async () =>
      ({
        session: { shop },
        admin: {},
        storefront: {},
        liquid: vi.fn(),
      }) as never,
    customerSigningKey: async (s) => (s === shop ? key : null),
    throttleStore: memoryThrottleStore(),
    now: () => now,
    ...overrides,
  };
}

function request(query: Record<string, string>, init: RequestInit = {}) {
  const params = new URLSearchParams({
    shop,
    logged_in_customer_id: "",
    path_prefix: "/apps/repairs",
    timestamp: ts,
    signature: "stubbed",
    ...query,
  });
  return new Request(`https://shopcare.test/proxy/orders?${params}`, init);
}

const token = (id: string, k = key, at = ts) => ({
  customer_id: id,
  customer_ts: at,
  customer_sig: signCustomerToken(k, id, at),
});

const customerFor = async (query: Record<string, string>, d = deps()) =>
  (await authenticateProxy(request(query), d)).currentCustomerId();

describe("currentCustomerId", () => {
  it("is Shopify's logged_in_customer_id", async () => {
    expect(await customerFor({ logged_in_customer_id: "777" })).toBe("777");
  });

  it("is null for a guest", async () => {
    expect(await customerFor({})).toBeNull();
  });

  it("ignores a browser-supplied customer id (the visitor controls the signed query)", async () => {
    expect(await customerFor({ customer_id: "777" })).toBeNull();
  });

  it("accepts a signed customer token in place of a missing logged_in_customer_id", async () => {
    expect(await customerFor(token("777"))).toBe("777");
  });

  it("treats a tampered, expired or other shop's token as logged out", async () => {
    const expired = String(Number(ts) - 25 * 3600);
    expect(
      await customerFor({ ...token("777"), customer_id: "778" }),
    ).toBeNull();
    expect(await customerFor(token("777", key, expired))).toBeNull();
    expect(await customerFor(token("777", "o".repeat(64)))).toBeNull();
  });

  it("ignores a token when the shop has no signing key", async () => {
    const d = deps({ customerSigningKey: async () => null });
    expect(await customerFor(token("777", ""), d)).toBeNull();
  });

  it("prefers logged_in_customer_id over a token, without looking up the key", async () => {
    const customerSigningKey = vi.fn(async () => key);
    const d = deps({ customerSigningKey });
    expect(
      await customerFor({ ...token("777"), logged_in_customer_id: "555" }, d),
    ).toBe("555");
    expect(customerSigningKey).not.toHaveBeenCalled();
  });
});

describe("authenticateProxy", () => {
  it("passes a signature failure through", async () => {
    const d = deps({
      authenticate: async () => {
        throw new Response(undefined, { status: 400 });
      },
    });
    await expect(authenticateProxy(request({}), d)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("keeps a well-formed custom path_prefix and remembers it", async () => {
    const rememberPathPrefix = vi.fn(async () => {});
    const ctx = await authenticateProxy(
      request({ path_prefix: "/apps/fix" }),
      deps({ rememberPathPrefix }),
    );
    expect(ctx.pathPrefix).toBe("/apps/fix");
    expect(rememberPathPrefix).toHaveBeenCalledWith(shop, "/apps/fix");
  });

  it("falls back to /apps/repairs for a malformed path_prefix", async () => {
    const rememberPathPrefix = vi.fn(async () => {});
    const ctx = await authenticateProxy(
      request({ path_prefix: '/apps/../x"><script>' }),
      deps({ rememberPathPrefix }),
    );
    expect(ctx.pathPrefix).toBe("/apps/repairs");
    expect(rememberPathPrefix).not.toHaveBeenCalled();
  });
});

describe("proxyRoute", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  const run = (route: ReturnType<typeof proxyRoute>, req: Request) =>
    route({ request: req });

  it("404s a shop without the app installed", async () => {
    restore = configureAppProxy(
      deps({ authenticate: async () => ({ session: undefined }) as never }),
    );
    const handler = vi.fn();
    const response = await run(proxyRoute({}, handler), request({}));
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(handler).not.toHaveBeenCalled();
  });

  it("throttles before the handler runs", async () => {
    restore = configureAppProxy(deps());
    const handler = vi.fn(() => new Response("ok"));
    const route = proxyRoute(
      { throttle: { name: "t", perIp: 1, perShop: 100, periodSeconds: 60 } },
      handler,
    );
    const req = () =>
      request({}, { headers: { "x-forwarded-for": "203.0.113.5" } });
    expect((await run(route, req())).status).toBe(200);
    expect((await run(route, req())).status).toBe(429);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("refuses to publicly cache a response that read the customer", async () => {
    restore = configureAppProxy(deps());
    const route = proxyRoute({}, async (ctx) => {
      await ctx.currentCustomerId();
      return ctx.json({}, { cache: { maxAge: 60, varyOn: [] } });
    });
    await expect(
      run(route, request({ logged_in_customer_id: "777" })),
    ).rejects.toThrow(/read the customer/);
  });

  it("refuses to publicly cache a POST", async () => {
    restore = configureAppProxy(deps());
    const route = proxyRoute({}, (ctx) =>
      ctx.json({}, { cache: { maxAge: 60, varyOn: [] } }),
    );
    await expect(run(route, request({}, { method: "POST" }))).rejects.toThrow(
      /POST/,
    );
  });

  it("answers per-customer JSON as no-store and Liquid pages as application/liquid", async () => {
    restore = configureAppProxy(deps());
    const json = proxyRoute({}, async (ctx) =>
      ctx.json(
        { customer: await ctx.currentCustomerId() },
        { cache: "no-store" },
      ),
    );
    const response = await run(json, request({ logged_in_customer_id: "777" }));
    expect(await response.json()).toEqual({ customer: "777" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");

    const page = proxyRoute({}, (ctx) =>
      ctx.liquid("<p>x</p>", { layout: false }),
    );
    const html = await run(page, request({}));
    expect(html.headers.get("Content-Type")).toBe("application/liquid");
    expect(await html.text()).toBe("{% layout none %}<p>x</p>");
  });
});

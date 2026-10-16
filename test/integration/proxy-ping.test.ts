/**
 * The example App Proxy route through the real signature check
 * (`authenticate.public.appProxy`). Signature cases ported from Rails
 * test/integration/proxy_*_test.rb ("needs Shopify's signature").
 */
import { afterEach, describe, expect, it } from "vitest";
import { loader } from "../../app/routes/proxy.ping";
import { configureAppProxy } from "../../app/lib/app-proxy.server";
import { memoryThrottleStore } from "../../app/lib/proxy-throttling.server";
import { appProxyRequest } from "../support/shopify-requests";
import { createSession } from "../support/factories";

const shop = "acme.myshopify.com";
const run = (request: Request) =>
  loader({ request, params: {}, context: {} } as Parameters<typeof loader>[0]);

describe("GET /proxy/ping (App Proxy)", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("answers a signed request and marks it cacheable on the CDN", async () => {
    await createSession({ shop, id: `offline_${shop}` });

    const response = await run(appProxyRequest("/proxy/ping", { shop }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, installed: true });
    expect(response.headers.get("Netlify-CDN-Cache-Control")).toBe(
      "public, durable, max-age=300, stale-while-revalidate=1200",
    );
    expect(response.headers.get("Netlify-Vary")).toBe("query=shop");
    expect(response.headers.get("Netlify-Cache-Tag")).toBe(`shop:${shop}`);
  });

  it("reports a shop that hasn't installed the app", async () => {
    const response = await run(appProxyRequest("/proxy/ping", { shop }));
    expect(await response.json()).toEqual({ ok: true, installed: false });
  });

  it("rejects a request with a forged signature", async () => {
    const signed = new URL(appProxyRequest("/proxy/ping", { shop }).url);
    signed.searchParams.set("signature", "0".repeat(64));
    await expect(run(new Request(signed))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects an unsigned request", async () => {
    await expect(
      run(
        new Request(
          `https://shopcare.test/proxy/ping?shop=${shop}&signature=deadbeef`,
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a tampered param", async () => {
    const signed = new URL(
      appProxyRequest("/proxy/ping", { shop, extra: { q: "aria" } }).url,
    );
    signed.searchParams.set("q", "boot");
    await expect(run(new Request(signed))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects a correctly signed but stale request (replay)", async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 600);
    await expect(
      run(
        appProxyRequest("/proxy/ping", { shop, extra: { timestamp: stale } }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("is throttled per visitor IP", async () => {
    restore = configureAppProxy({ throttleStore: memoryThrottleStore() });
    const from = (ip: string) =>
      appProxyRequest("/proxy/ping", {
        shop,
        init: { headers: { "x-forwarded-for": ip } },
      });
    for (let i = 0; i < 60; i++)
      expect((await run(from("203.0.113.5"))).status).toBe(200);
    const limited = await run(from("203.0.113.5"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await run(from("198.51.100.7"))).status).toBe(200);
  });
});

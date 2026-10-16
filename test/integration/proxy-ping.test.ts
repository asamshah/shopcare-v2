import { describe, expect, it } from "vitest";
import { loader } from "../../app/routes/proxy.ping";
import { appProxyRequest } from "../support/shopify-requests";
import { createSession } from "../support/factories";

const shop = "acme.myshopify.com";
const run = (request: Request) =>
  loader({ request, params: {}, context: {} } as Parameters<typeof loader>[0]);

describe("GET /proxy/ping (App Proxy)", () => {
  it("answers a signed request and marks it cacheable on the CDN", async () => {
    await createSession({ shop, id: `offline_${shop}` });

    const response = await run(appProxyRequest("/proxy/ping", { shop }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, installed: true });
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
});

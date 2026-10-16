import { proxyRoute } from "../lib/app-proxy.server";

/**
 * GET /apps/repairs/ping on the storefront (Shopify proxies it to /proxy/ping).
 * A smoke test for the App Proxy and the example every proxy route follows:
 * `proxyRoute` checks Shopify's signature, 404s an uninstalled shop (ping opts
 * out so it can report it), applies the throttle, then the handler answers
 * with `ctx.json`, choosing its cache policy explicitly. See the "App Proxy
 * routes" section of docs/PORTING.md.
 */
export const loader = proxyRoute(
  {
    allowUninstalled: true,
    throttle: { name: "ping", perIp: 60, perShop: 1200, periodSeconds: 60 },
  },
  (ctx) =>
    ctx.json(
      { ok: true, installed: Boolean(ctx.session) },
      // Public: the same for every visitor of the shop, so the CDN may keep it.
      { cache: { maxAge: 300, varyOn: [], tags: [`shop:${ctx.shop}`] } },
    ),
);

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { publicCacheHeaders } from "../lib/http.server";

/**
 * GET /apps/repairs/ping on the storefront (Shopify proxies it to /proxy/ping).
 * A smoke test for the App Proxy and the public-cache pattern. The ported proxy
 * routes (status, intake, care_plans, …) follow the same shape: check the
 * signature with `authenticate.public.appProxy`, then respond.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  const shop = new URL(request.url).searchParams.get("shop");
  const headers = publicCacheHeaders({
    maxAge: 300,
    varyOn: [],
    tags: shop ? [`shop:${shop}`] : [],
  });
  headers.set("Content-Type", "application/json");
  return new Response(
    JSON.stringify({ ok: true, installed: Boolean(session) }),
    { headers },
  );
};

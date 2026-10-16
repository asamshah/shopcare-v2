/**
 * Caching for public App Proxy responses.
 *
 * The theme extension calls the proxy on every product page (care_plans, for
 * example). Each uncached call is a Netlify Function invocation, which costs
 * money and adds latency. Responses that don't depend on the customer can
 * be cached on Netlify's CDN.
 *
 * Shopify signs every proxied request (`signature`, `timestamp`, and so on in
 * the query string), and Netlify includes the full query in the cache key by
 * default, so without `Netlify-Vary` nothing would ever hit. `varyOn` lists
 * the query params that actually change the response (always include `shop`).
 *
 * Only use this for responses that are identical for every visitor. Never use
 * it for anything that reads `logged_in_customer_id` or returns personal data:
 * a cache hit skips the signature check entirely.
 * https://docs.netlify.com/build/caching/caching-overview/
 */
export interface PublicCacheOptions {
  /** Seconds the CDN treats the response as fresh. */
  maxAge: number;
  /** Extra seconds a stale copy may be served while revalidating. */
  staleWhileRevalidate?: number;
  /** Query params that change the response. */
  varyOn: string[];
  /** Netlify cache tags, for targeted purges (e.g. `shop:<domain>`). */
  tags?: string[];
}

export function publicCacheHeaders({
  maxAge,
  staleWhileRevalidate = maxAge * 4,
  varyOn,
  tags = [],
}: PublicCacheOptions): Headers {
  const headers = new Headers();
  // Browsers: short, so a merchant's change shows up quickly on reload.
  headers.set("Cache-Control", "public, max-age=60");
  // Netlify CDN: `durable` shares the cached function response across edge nodes.
  headers.set(
    "Netlify-CDN-Cache-Control",
    `public, durable, max-age=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`,
  );
  headers.set(
    "Netlify-Vary",
    `query=${["shop", ...varyOn.filter((p) => p !== "shop")].join("|")}`,
  );
  if (tags.length) headers.set("Netlify-Cache-Tag", tags.join(","));
  return headers;
}

/** For customer-specific proxy responses: never stored by any cache. */
export function privateNoStoreHeaders(): Headers {
  return new Headers({ "Cache-Control": "private, no-store" });
}

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

/**
 * For customer-specific or mutating proxy responses: never stored by any
 * cache. Netlify doesn't cache function responses unless told to, but the
 * explicit CDN header keeps a stray `CDN-Cache-Control` from changing that.
 */
export function privateNoStoreHeaders(): Headers {
  return new Headers({
    "Cache-Control": "private, no-store",
    "Netlify-CDN-Cache-Control": "no-store",
  });
}

export type CachePolicy = "no-store" | PublicCacheOptions;

function cacheHeaders(cache: CachePolicy): Headers {
  return cache === "no-store"
    ? privateNoStoreHeaders()
    : publicCacheHeaders(cache);
}

function mergeHeaders(base: Headers, extra?: HeadersInit): Headers {
  if (extra) new Headers(extra).forEach((value, key) => base.set(key, value));
  return base;
}

/**
 * A JSON response. `cache` is required so every proxy endpoint decides: pass
 * "no-store" for anything customer-specific, or PublicCacheOptions for data
 * that's identical for every visitor.
 */
export function jsonResponse(
  body: unknown,
  {
    cache,
    status = 200,
    headers,
  }: { cache: CachePolicy; status?: number; headers?: HeadersInit },
): Response {
  const merged = mergeHeaders(cacheHeaders(cache), headers);
  merged.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: merged });
}

/**
 * Text for a page Shopify renders as Liquid (App Proxy pages): HTML-escaped,
 * with braces escaped too, so a value like "{{ shop.name }}" or "{% … %}"
 * can't run as Liquid. Port of Rails `LiquidHelper#liquid_text`.
 */
export function liquidText(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

/**
 * An HTML page Shopify renders inside the merchant's theme
 * (`Content-Type: application/liquid`). Escape every dynamic value with
 * `liquidText`. `layout: false` renders without the theme layout. Unlike the
 * template's `liquid()` helper this doesn't rewrite form actions or links
 * (it appends trailing slashes, which the ported routes don't expect).
 * No-store by default, as the Rails quote page.
 */
export function liquidResponse(
  html: string,
  {
    status = 200,
    layout = true,
    cache = "no-store",
    headers,
  }: {
    status?: number;
    layout?: boolean;
    cache?: CachePolicy;
    headers?: HeadersInit;
  } = {},
): Response {
  const merged = mergeHeaders(cacheHeaders(cache), headers);
  merged.set("Content-Type", "application/liquid");
  const body = layout ? html : `{% layout none %}${html}`;
  return new Response(body, { status, headers: merged });
}

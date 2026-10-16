/**
 * Builds requests signed the way Shopify signs them, so routes run through
 * the real `authenticate.*` checks instead of stubs. This ports the Rails
 * test/support/proxy_signing.rb pattern and adds webhooks.
 */
import { createHmac } from "node:crypto";

const secret = () => process.env.SHOPIFY_API_SECRET ?? "";
const appUrl = () => process.env.SHOPIFY_APP_URL ?? "https://shopcare.test";

/**
 * An App Proxy request: Shopify sends /apps/repairs/<path> to /proxy/<path>,
 * adding shop, logged_in_customer_id, path_prefix and timestamp, and a
 * `signature` (hex HMAC-SHA256 of the sorted "k=v" pairs, joined with nothing).
 */
export function appProxyRequest(
  path: string,
  {
    shop,
    customerId = "",
    extra = {},
    init = {},
  }: {
    shop: string;
    customerId?: string;
    extra?: Record<string, string>;
    init?: RequestInit;
  },
): Request {
  const params: Record<string, string> = {
    shop,
    logged_in_customer_id: customerId,
    path_prefix: "/apps/repairs",
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...extra,
  };
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("");
  const signature = createHmac("sha256", secret())
    .update(message)
    .digest("hex");
  const query = new URLSearchParams({ ...params, signature });
  return new Request(`${appUrl()}${path}?${query}`, init);
}

/** A webhook delivery with a valid X-Shopify-Hmac-Sha256 header. */
export function webhookRequest(
  path: string,
  {
    topic,
    shop,
    payload,
    webhookId = `wh-${Date.now()}`,
  }: {
    topic: string;
    shop: string;
    payload: unknown;
    webhookId?: string;
  },
): Request {
  const body = JSON.stringify(payload);
  const hmac = createHmac("sha256", secret()).update(body).digest("base64");
  return new Request(`${appUrl()}${path}`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": hmac,
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": shop,
      "x-shopify-webhook-id": webhookId,
      "x-shopify-api-version": "2026-10",
      "x-shopify-event-id": `ev-${webhookId}`,
      "x-shopify-triggered-at": new Date().toISOString(),
    },
  });
}

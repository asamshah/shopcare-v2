/**
 * Verifies the logged-in customer token the theme blocks send to the App Proxy
 * (customer_id, customer_ts, customer_sig). Liquid signs it while rendering the
 * page, where it knows `customer`
 * (extensions/repair-intake/snippets/shopcare_customer_query.liquid):
 *
 *   customer.id | append: ':' | append: ts | hmac_sha256: <customer signing key>
 *
 * Shopify signs whatever query the visitor sends, so only this HMAC, under a
 * secret only Liquid and the app know, proves the id. Tokens last a day, so a
 * page rendered earlier (a cached page, a tab left open) still works.
 *
 * Port of Rails `Shopify::CustomerToken`. The Rails version took the shop and
 * read `shop.customer_signing_key`; here the caller passes the key, so this
 * stays a pure function (the key lookup is injected in app-proxy.server.ts).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const TTL_SECONDS = 24 * 60 * 60;
export const CLOCK_SKEW_SECONDS = 5 * 60;

const DIGITS = /^\d+$/;

/** What Liquid's `hmac_sha256` filter renders: lowercase hex. */
export function signCustomerToken(
  signingKey: string,
  customerId: string,
  timestamp: string | number,
): string {
  return createHmac("sha256", signingKey)
    .update(`${customerId}:${timestamp}`)
    .digest("hex");
}

/** The verified customer id, or null. */
export function verifiedCustomerId(
  signingKey: string | null | undefined,
  customerId: string | null | undefined,
  timestamp: string | null | undefined,
  signature: string | null | undefined,
  { now = new Date() }: { now?: Date } = {},
): string | null {
  const id = customerId ?? "";
  const ts = timestamp ?? "";
  if (!signingKey?.trim() || !signature?.trim()) return null;
  if (!DIGITS.test(id) || !DIGITS.test(ts)) return null;

  const age = Math.floor(now.getTime() / 1000) - Number(ts);
  if (age > TTL_SECONDS || age < -CLOCK_SKEW_SECONDS) return null;

  const expected = signCustomerToken(signingKey, id, ts);
  return secureCompare(expected, signature) ? id : null;
}

/**
 * Exact string comparison in constant time for equal lengths, like Rails'
 * `secure_compare`. Deliberately not hex-decoding: Buffer.from(s, "hex")
 * stops at the first non-hex character, so trailing junk would still match.
 */
function secureCompare(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

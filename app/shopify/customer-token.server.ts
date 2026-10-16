/**
 * Verifies the logged-in customer token the theme blocks send to the App Proxy
 * (customer_id, customer_ts, customer_sig). Liquid signs it while rendering
 * the page, where it knows `customer`:
 *   customer.id | append: ':' | append: ts | hmac_sha256: <customer signing key>
 * Shopify signs whatever query the visitor sends, so only this HMAC, under a
 * secret only Liquid and the app know, proves the id. Tokens last a day, so a
 * page rendered earlier (a cached page, a tab left open) still works.
 * Ported from Rails `Shopify::CustomerToken`.
 */
import { hmacHex, safeEqualHex } from "../lib/signing.server";

export const CUSTOMER_TOKEN_TTL_SECONDS = 24 * 60 * 60;
export const CUSTOMER_TOKEN_CLOCK_SKEW_SECONDS = 5 * 60;

const DIGITS = /^\d+$/;
const HEX = /^[0-9a-f]+$/i;

/** The verified customer id, or null. `signingKey` is the shop's decrypted key. */
export function verifiedCustomerId(
  signingKey: string | null | undefined,
  customerId: unknown,
  timestamp: unknown,
  signature: unknown,
  now: Date = new Date(),
): string | null {
  const id = customerId == null ? "" : String(customerId);
  const ts = timestamp == null ? "" : String(timestamp);
  const sig = signature == null ? "" : String(signature);
  if (!signingKey || !sig || !DIGITS.test(id) || !DIGITS.test(ts)) return null;

  const age = Math.floor(now.getTime() / 1000) - Number(ts);
  if (
    age > CUSTOMER_TOKEN_TTL_SECONDS ||
    age < -CUSTOMER_TOKEN_CLOCK_SKEW_SECONDS
  )
    return null;

  if (!HEX.test(sig)) return null;
  const expected = hmacHex(signingKey, `${id}:${ts}`);
  return safeEqualHex(expected, sig.toLowerCase()) ? id : null;
}

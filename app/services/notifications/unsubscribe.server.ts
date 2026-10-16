/**
 * Signed one-click unsubscribe links for ShopCare's marketing email ("Add
 * Care to your purchase"). The token carries the shop, the address and the
 * Shopify customer id, signed with an HMAC key derived from
 * APP_ENCRYPTION_KEY. It doesn't expire: an unsubscribe link must keep
 * working. Served by app/routes/email.unsubscribe.tsx (GET shows a
 * confirmation page, POST, including RFC 8058 one-click, unsubscribes).
 */
import { derivedSecret, hmacHex, safeEqualHex } from "../../lib/signing.server";
import type { DeliveryRecipient } from "./store.server";

export const UNSUBSCRIBE_PATH = "/email/unsubscribe";

export interface UnsubscribeClaims {
  /** myshopify domain. */
  shop: string;
  email: string;
  customerId: string | null;
}

const secret = () => derivedSecret("shopcare:email-unsubscribe");

export function signUnsubscribeToken(claims: UnsubscribeClaims): string {
  const body = Buffer.from(
    JSON.stringify({ s: claims.shop, e: claims.email, c: claims.customerId }),
  ).toString("base64url");
  return `${body}.${hmacHex(secret(), body)}`;
}

export function verifyUnsubscribeToken(
  token: string | null | undefined,
): UnsubscribeClaims | null {
  if (!token || token.length > 2000) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  if (!safeEqualHex(sig, hmacHex(secret(), body))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof parsed?.s !== "string" || typeof parsed?.e !== "string")
      return null;
    return {
      shop: parsed.s,
      email: parsed.e,
      customerId: typeof parsed.c === "string" && parsed.c ? parsed.c : null,
    };
  } catch {
    return null;
  }
}

/**
 * The unsubscribe URL for a marketing email (NotificationDeps.unsubscribeUrl),
 * or null without an address or app URL.
 */
export function unsubscribeUrl(
  shopDomain: string,
  recipient: DeliveryRecipient,
  baseUrl = process.env.SHOPIFY_APP_URL ?? "",
): string | null {
  if (!recipient.email || !baseUrl) return null;
  const token = signUnsubscribeToken({
    shop: shopDomain,
    email: recipient.email,
    customerId: recipient.customerId ? String(recipient.customerId) : null,
  });
  return `${baseUrl.replace(/\/$/, "")}${UNSUBSCRIBE_PATH}?token=${token}`;
}

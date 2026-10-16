/**
 * The email suppression list (`email_suppressions`): addresses ShopCare must
 * not email, checked by the notification job before every send.
 *
 *   unsubscribe  per shop, marketing only (the signed unsubscribe link,
 *                app/routes/email.unsubscribe.tsx)
 *   complaint    per shop when the provider message can be traced to a
 *                delivery, else global; every email (Resend `email.complained`)
 *   bounce       global, every email (Resend `email.bounced`, permanent only)
 *
 * Addresses are stored as a SHA-256 digest of the trimmed, lower-cased
 * address, so the list holds no readable personal data and doesn't need
 * redacting on `customers/redact` (the opt-out must outlive the redaction).
 */
import { createHash } from "node:crypto";
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";

export type SuppressionKind = "marketing" | "all";
export type SuppressionReason = "unsubscribe" | "bounce" | "complaint";

export function emailDigest(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

export const GLOBAL_SCOPE = "global";
const shopScope = (shopId: number) => `shop:${shopId}`;

export interface SuppressInput {
  /** The shop's row id; null for a global suppression. */
  shopId: number | null;
  email: string;
  kind: SuppressionKind;
  reason: SuppressionReason;
  detail?: string | null;
}

/** Records a suppression; repeating it is a no-op (latest detail kept). */
export async function suppressEmail(
  { shopId, email, kind, reason, detail = null }: SuppressInput,
  db: Db = prisma,
): Promise<void> {
  const scopeKey = shopId === null ? GLOBAL_SCOPE : shopScope(shopId);
  const digest = emailDigest(email);
  await db.emailSuppression.upsert({
    where: {
      scopeKey_emailDigest_kind: { scopeKey, emailDigest: digest, kind },
    },
    create: { shopId, scopeKey, emailDigest: digest, kind, reason, detail },
    update: { reason, detail },
  });
}

/**
 * True when `email` mustn't be sent this email by the shop `shopDomain`:
 * a global or shop-level "all" suppression, or (for marketing) a "marketing"
 * one.
 */
export async function isEmailSuppressed(
  shopDomain: string,
  email: string,
  { marketing }: { marketing: boolean },
  db: Db = prisma,
): Promise<boolean> {
  const shop = await db.shop.findUnique({
    where: { shopifyDomain: shopDomain },
    select: { id: true },
  });
  const scopes = [GLOBAL_SCOPE, ...(shop ? [shopScope(shop.id)] : [])];
  const count = await db.emailSuppression.count({
    where: {
      emailDigest: emailDigest(email),
      scopeKey: { in: scopes },
      kind: { in: marketing ? ["all", "marketing"] : ["all"] },
    },
  });
  return count > 0;
}

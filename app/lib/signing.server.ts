/**
 * Small HMAC helpers shared by signed file URLs and background-function
 * dispatch. They compare signatures in constant time.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export function hmacHex(secret: string | Buffer, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

const HEX = /^(?:[0-9a-f]{2})+$/i;

/**
 * Constant-time comparison of two hex digests. Both must be non-empty,
 * even-length, all-hex and the same length; anything else is unequal. (Without
 * this, Buffer.from(s, "hex") stops at the first non-hex character, so a
 * signature with trailing junk would compare equal.)
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length || !HEX.test(a) || !HEX.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * Derives a purpose-specific secret from APP_ENCRYPTION_KEY (HKDF-SHA256), so
 * each signing use gets its own key without needing another env var.
 */
export function derivedSecret(purpose: string): Buffer {
  const master = process.env.APP_ENCRYPTION_KEY;
  if (!master) throw new Error("APP_ENCRYPTION_KEY is not set.");
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(master, "base64"),
      Buffer.alloc(0),
      purpose,
      32,
    ),
  );
}

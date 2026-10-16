/**
 * Small HMAC helpers shared by signed file URLs and background-function
 * dispatch. They compare signatures in constant time.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export function hmacHex(secret: string | Buffer, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return (
    left.length === right.length &&
    left.length > 0 &&
    timingSafeEqual(left, right)
  );
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

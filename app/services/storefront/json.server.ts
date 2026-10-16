/**
 * Small helpers that keep the storefront JSON byte-compatible with the Rails
 * App Proxy controllers (the theme extension's JS is unchanged and reads
 * exactly those keys and formats).
 */
import { Prisma } from "@prisma/client";

/** Rails `Time#iso8601` in UTC: seconds precision, "Z". */
export function iso8601(date: Date | null | undefined): string | null {
  return date ? date.toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}

/** Rails `time.to_date.iso8601` (UTC zone): "2026-10-16". */
export function isoDate(date: Date | null | undefined): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/** Rails `format("%.2f", value)`. */
export function money2(value: Prisma.Decimal | number | string): string {
  return new Prisma.Decimal(value).toFixed(2);
}

/** Rails `status.tr("_", " ").capitalize`: "in_repair" → "In repair". */
export function statusLabel(status: string): string {
  const text = status.replace(/_/g, " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Rails `Hash#compact`: drops null and undefined values, keeps key order. */
export function compact<T extends Record<string, unknown>>(
  hash: T,
): { [K in keyof T]?: Exclude<T[K], null | undefined> } {
  return Object.fromEntries(
    Object.entries(hash).filter(([, value]) => value !== null && value !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], null | undefined> };
}

/** Rails `String#truncate(length)` with the default "..." omission. */
export function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

/** Rails `presence` for strings: null when blank. */
export function presence(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.trim() === "" ? null : text;
}

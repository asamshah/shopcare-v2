/** Amount formatting shared by quotes and Care plan terms (Rails Quotation::CURRENCY_SYMBOLS). */
import { Prisma } from "@prisma/client";

export const CURRENCY_SYMBOLS: Record<string, string> = { GBP: "£", USD: "$", EUR: "€" };

/** "£12.50", or "12.50 CAD" when there's no symbol for the currency. */
export function formatAmount(
  value: Prisma.Decimal | number | string,
  currency: string | null | undefined,
): string {
  const amount = new Prisma.Decimal(value).toFixed(2);
  const symbol = currency ? CURRENCY_SYMBOLS[currency] : undefined;
  return symbol ? `${symbol}${amount}` : `${amount} ${currency ?? ""}`;
}

/** Ruby `BigDecimal#to_s("F").sub(/\.0\z/, "")`: "25", "12.5". */
export function plainNumber(value: Prisma.Decimal | number): string {
  return new Prisma.Decimal(value).toString();
}

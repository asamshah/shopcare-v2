/** Money and decimal display (server only: Prisma.Decimal arithmetic). See format.ts. */
import { Prisma } from "@prisma/client";
import { CURRENCY_SYMBOLS } from "./money";

export type Numeric = Prisma.Decimal | number | string | null | undefined;

function decimal2(value: Numeric): string {
  return new Prisma.Decimal(value === null || value === undefined || value === "" ? 0 : value).toFixed(2);
}

function delimit(fixed: string): string {
  const [whole, fraction] = fixed.split(".");
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${fraction}`;
}

/** Rails `format_money`: "£1,234.50"; "12.50 CAD" without a symbol; "12.50" without a currency. */
export function formatMoney(amount: Numeric, currency?: string | null): string {
  const fixed = decimal2(amount);
  const symbol = currency ? CURRENCY_SYMBOLS[currency] : undefined;
  if (symbol) {
    const text = delimit(fixed);
    return text.startsWith("-") ? `-${symbol}${text.slice(1)}` : `${symbol}${text}`;
  }
  return currency ? `${fixed} ${currency}` : fixed;
}

/** "12.5", "25" (Rails PartsHelper#decimal). */
export function decimal(value: Numeric): string {
  return new Prisma.Decimal(value === null || value === undefined || value === "" ? 0 : value).toString();
}


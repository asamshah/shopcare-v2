/**
 * Display helpers for the admin screens (Rails TicketsHelper, ItemsHelper,
 * PartsHelper, TradeInsHelper and the strftime formats the views used).
 * Dates are formatted in UTC on the server (Rails' default Time.zone), so
 * loaders return ready-made strings and hydration never disagrees.
 */

export type Tone = "info" | "success" | "caution" | "warning" | "critical" | "neutral";

const TICKET_STATUS_TONES: Record<string, Tone> = {
  new: "info",
  assessing: "caution",
  quoted: "warning",
  quote_declined: "critical",
  in_repair: "caution",
  ready: "success",
  completed: "success",
  cancelled: "neutral",
  rejected: "critical",
};

const QUOTATION_STATUS_TONES: Record<string, Tone> = {
  draft: "neutral",
  sent: "caution",
  paid: "success",
  declined: "critical",
  expired: "warning",
  cancelled: "neutral",
};

const REGISTRATION_TONES: Record<string, Tone> = {
  unverified: "caution",
  verified: "success",
  rejected: "critical",
};

const ITEM_STATUS_TONES: Record<string, Tone> = {
  active: "success",
  refunded: "neutral",
  void: "critical",
};

const MOVEMENT_TONES: Record<string, Tone> = {
  received: "success",
  consumed: "info",
  adjusted: "caution",
  stock_count: "caution",
};

const TRADE_IN_TONES: Record<string, Tone> = {
  requested: "info",
  approved: "caution",
  received: "warning",
  crediting: "warning",
  credited: "success",
  rejected: "critical",
  cancelled: "neutral",
  pending_purchase: "neutral",
};

export const ticketStatusTone = (s: string): Tone => TICKET_STATUS_TONES[s] ?? "neutral";
export const quotationStatusTone = (s: string): Tone => QUOTATION_STATUS_TONES[s] ?? "neutral";
export const registrationTone = (s: string | null | undefined): Tone =>
  (s && REGISTRATION_TONES[s]) || "neutral";
export const itemStatusTone = (s: string): Tone => ITEM_STATUS_TONES[s] ?? "neutral";
export const movementTone = (s: string): Tone => MOVEMENT_TONES[s] ?? "neutral";
export const tradeInTone = (s: string): Tone => TRADE_IN_TONES[s] ?? "neutral";

/** "in_repair" → "In repair". */
export function statusLabel(status: string | null | undefined): string {
  const text = String(status ?? "").replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

export const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();

/** "1 repair service", "3 repair services". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "%d %b %Y": "05 Oct 2026". */
export function formatDate(date: Date | null | undefined): string {
  if (!date) return "";
  return `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "%d %b %Y, %H:%M". */
export function formatDateTime(date: Date | null | undefined): string {
  if (!date) return "";
  return `${formatDate(date)}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** "%d %b, %H:%M". */
export function formatShortDateTime(date: Date | null | undefined): string {
  if (!date) return "";
  return `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** "%b %Y": "Oct 2028". */
export function formatMonthYear(date: Date | null | undefined): string {
  if (!date) return "";
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** ISO date "2026-10-16" (UTC). */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Rails `truncate(text, length:)`. */
export function truncate(text: string | null | undefined, length: number): string {
  const value = text ?? "";
  return value.length > length ? `${value.slice(0, length - 3)}...` : value;
}

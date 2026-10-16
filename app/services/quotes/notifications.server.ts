/**
 * Staff alerts about a sent quote: paid (accepted), declined or expired.
 * Port of Repairs::QuoteNotifications. They go to the staff email ("Notify
 * staff at") and, when enabled, the Flow staff-alert triggers / Klaviyo. The
 * customer's quote email is Shopify's own invoice (sendQuote).
 */
import type { Quotation, RepairTicket, Shop } from "@prisma/client";
import { formattedSubtotal, validUntil } from "../../models/quotation.server";
import { adminTicketUrl } from "../../models/shop.server";
import { notify, type NotifyOptions } from "../notifications/notify.server";

type Q = Pick<Quotation, "id" | "currency" | "subtotal" | "decisionReason" | "decisionExpiresAt">;
type T = Pick<
  RepairTicket,
  "id" | "productTitle" | "customerName" | "customerEmail" | "shopifyCustomerId"
>;

function base(quotation: Q, ticket: T, shop: Pick<Shop, "shopifyDomain">) {
  return {
    quotationId: quotation.id,
    ticketId: ticket.id,
    productTitle: ticket.productTitle ?? "",
    customerName: ticket.customerName ?? "",
    customerEmail: ticket.customerEmail ?? "",
    quoteTotal: formattedSubtotal(quotation),
    adminUrl: adminTicketUrl(shop.shopifyDomain, ticket.id),
  };
}

const recipientOf = (ticket: T) => ({
  customerId: ticket.shopifyCustomerId,
  email: ticket.customerEmail,
  name: ticket.customerName,
});

export function notifyQuotePaid(
  shop: Pick<Shop, "shopifyDomain">,
  quotation: Q,
  ticket: T,
  orderName: string,
  options?: NotifyOptions,
) {
  return notify(
    shop.shopifyDomain,
    "quote_paid",
    recipientOf(ticket),
    { ...base(quotation, ticket, shop), orderName },
    options,
  );
}

export function notifyQuoteDeclined(
  shop: Pick<Shop, "shopifyDomain">,
  quotation: Q,
  ticket: T,
  options?: NotifyOptions,
) {
  return notify(
    shop.shopifyDomain,
    "quote_declined",
    recipientOf(ticket),
    { ...base(quotation, ticket, shop), reason: quotation.decisionReason ?? "" },
    options,
  );
}

export function notifyQuoteExpired(
  shop: Pick<Shop, "shopifyDomain">,
  quotation: Q,
  ticket: T,
  options?: NotifyOptions,
) {
  return notify(
    shop.shopifyDomain,
    "quote_expired",
    recipientOf(ticket),
    { ...base(quotation, ticket, shop), validUntil: validUntil(quotation) ?? "" },
    options,
  );
}

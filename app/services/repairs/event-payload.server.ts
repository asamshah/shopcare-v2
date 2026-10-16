/**
 * The JSON payload sent to a merchant's outbound webhook when a repair ticket
 * changes (submitted / status_change / quote_sent / quote_declined /
 * payment). Ported from Rails Repairs::EventPayload; it takes plain objects so
 * it doesn't depend on how tickets are loaded.
 */

export interface EventPayloadTicket {
  id: number | string;
  status: string;
  customerEmail?: string | null;
  customerName?: string | null;
  productTitle?: string | null;
  orderNumber?: string | null;
  inWarranty?: boolean | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export interface EventPayloadQuotation {
  status: string;
  currency: string;
  /** Decimal subtotal (number or Prisma Decimal string). */
  subtotal: number | string;
  decisionExpiresAt?: Date | null;
  decidedAt?: Date | null;
  decidedBy?: string | null;
  decisionReason?: string | null;
  shopifyOrderId?: string | number | null;
}

export interface RepairEventPayload {
  event: string;
  detail?: string;
  shop: string;
  ticket: Record<string, unknown>;
  quotation?: Record<string, unknown>;
}

/** Rails `Hash#compact`: drops null/undefined values. */
function compact<T extends Record<string, unknown>>(hash: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(hash).filter(
      ([, value]) => value !== null && value !== undefined,
    ),
  ) as Partial<T>;
}

/** Rails Time#iso8601: seconds precision, "Z" for UTC. */
function iso8601(date: Date | null | undefined): string | null {
  return date ? date.toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}

export function buildRepairEventPayload({
  shopDomain,
  ticket,
  quotation,
  event,
  detail,
}: {
  shopDomain: string;
  ticket: EventPayloadTicket;
  /** The ticket's current (latest) quotation, if any. */
  quotation?: EventPayloadQuotation | null;
  event: string;
  detail?: string | null;
}): RepairEventPayload {
  return compact({
    event,
    detail: detail ?? undefined,
    shop: shopDomain,
    ticket: {
      id: ticket.id,
      status: ticket.status,
      customer_email: ticket.customerEmail ?? null,
      customer_name: ticket.customerName ?? null,
      product_title: ticket.productTitle ?? null,
      order_number: ticket.orderNumber ?? null,
      in_warranty: ticket.inWarranty ?? null,
      created_at: iso8601(ticket.createdAt),
      updated_at: iso8601(ticket.updatedAt),
    },
    quotation: quotation
      ? compact({
          status: quotation.status,
          currency: quotation.currency,
          subtotal: Number(quotation.subtotal).toFixed(2),
          expires_at: iso8601(quotation.decisionExpiresAt),
          decided_at: iso8601(quotation.decidedAt),
          decided_by: quotation.decidedBy,
          decision_reason: quotation.decisionReason,
          shopify_order_id: quotation.shopifyOrderId,
        })
      : undefined,
  }) as RepairEventPayload;
}

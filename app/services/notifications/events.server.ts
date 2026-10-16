/**
 * The notification events ShopCare emits, what each one carries, and which
 * channels it can go to. Ported from Rails `Notifications::Dispatcher::EVENTS`
 * (see "Notifications" in docs/PORTING.md).
 *
 * ShopCare sends no email: Shopify does (the draft-order invoice, the Order
 * confirmation snippet, the Shipping confirmation). Events are optional
 * integrations the merchant can build their own emails on; one event fans out
 * to up to two channels, each its own delivery record:
 *   flow     a Shopify Flow trigger (when Flow is on in Settings)
 *   klaviyo  a Klaviyo metric (when a Klaviyo key is saved)
 *
 * Callers pass typed event data; the Flow/Klaviyo fields (named exactly as in
 * extensions/shopcare-flow-* / parked/shopcare-flow-trade-in-status) are
 * derived from it here.
 */

export type Id = string | number;

/** Rails RepairTicket::STATUSES. */
export type RepairStatus =
  | "new"
  | "assessing"
  | "quoted"
  | "quote_declined"
  | "awaiting_item"
  | "received"
  | "in_repair"
  | "ready"
  | "completed"
  | "cancelled"
  | "rejected";

interface QuoteAlertBase {
  quotationId: Id;
  ticketId: Id;
  productTitle: string;
  customerName: string;
  customerEmail: string;
  /** Already formatted, e.g. "£20.00" (Rails Quotation#formatted_subtotal). */
  quoteTotal: string;
  /** Link to the ticket in the ShopCare admin, for staff alerts. */
  adminUrl?: string | null;
}

export interface EventData {
  /** A storefront repair request was submitted (Repairs::IntakeSubmission). New in v2: a staff alert. */
  repair_submitted: {
    ticketId: Id;
    productTitle: string;
    customerName?: string | null;
    customerEmail?: string | null;
    description?: string | null;
    /** Where the customer can follow the repair, if the shop has such a page. */
    statusUrl?: string | null;
    adminUrl?: string | null;
  };
  repair_status_changed: {
    ticketId: Id;
    status: RepairStatus;
    productTitle: string;
    customerName?: string | null;
    statusUrl?: string | null;
  };
  care_activated: {
    coverId: Id;
    carePlan: string;
    productTitle: string;
    /** ISO date, e.g. "2027-10-16". */
    coverEnds: string;
    customerName?: string | null;
  };
  care_credit_offer: {
    coverId: Id;
    carePlan: string;
    productTitle: string;
    creditCode: string;
    creditAmount: number;
    currency: string;
    /** ISO date, or "" when the code doesn't expire. */
    creditExpires: string;
    customerName?: string | null;
    storeUrl?: string | null;
  };
  care_offer: {
    orderId: Id;
    productTitle: string;
    carePlan: string;
    carePrice: number;
    currency: string;
    /** ISO date. */
    offerEnds: string;
    addCareUrl: string;
    customerName?: string | null;
  };
  quote_paid: QuoteAlertBase & { orderName: string };
  quote_declined: QuoteAlertBase & { reason: string };
  quote_expired: QuoteAlertBase & { validUntil: string };
  /**
   * GDPR customers/data_request: the export is stored and shown in the
   * admin. Flow only (staff alert); never Klaviyo, which would put the
   * export link on the customer's own profile.
   */
  data_request: {
    requestId: string;
    /** The customer's email, else "customer <id>". */
    customer: string;
    /** e.g. "1 repair ticket, 2 items, 0 trade-ins, 3 notifications". */
    summary: string;
    /** Signed download link (EXPORT_LINK_DAYS). */
    downloadUrl: string;
    /** Settings → Customer data requests in the ShopCare admin. */
    adminUrl: string;
  };
  /** Flow/Klaviyo only (parked trigger). */
  trade_in_status_changed: {
    tradeInId: Id;
    /** Rails status, e.g. "approved". */
    status: string;
    productTitle: string;
    credit: number;
    instructions: string;
    creditCode: string;
  };
}

export type EventName = keyof EventData;

export type Channel = "flow" | "klaviyo";

export type FlowFields = Record<string, string | number>;

interface EventDefinition<E extends EventName> {
  /** Flow trigger handle and Klaviyo metric name (Rails EVENTS), when the event has them. */
  flowHandle?: string;
  klaviyoMetric?: string;
  /** Staff alerts: the Flow trigger has no customer reference, so it fires for guests too. */
  staffAlert?: boolean;
  /** The record the event is about; the idempotency key is `<event>:<recordKey>`. */
  recordKey(data: EventData[E]): string;
  /** Flow trigger fields / Klaviyo event properties, keyed exactly as the trigger TOML. */
  fields(data: EventData[E]): FlowFields;
}

/** Rails: `status.tr("_", " ").capitalize`, e.g. "in_repair" → "In repair". */
export function humanizeStatus(status: string): string {
  const words = status.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function quoteBaseFields(data: QuoteAlertBase): FlowFields {
  return {
    "Ticket number": String(data.ticketId),
    "Product title": data.productTitle,
    "Customer name": data.customerName,
    "Customer email": data.customerEmail,
    "Quote total": data.quoteTotal,
  };
}

export const EVENTS: { [E in EventName]: EventDefinition<E> } = {
  repair_submitted: {
    flowHandle: "shopcare-repair-submitted",
    klaviyoMetric: "ShopCare Repair Submitted",
    staffAlert: true,
    recordKey: (d) => `ticket_${d.ticketId}`,
    fields: (d) => ({
      "Ticket number": String(d.ticketId),
      "Product title": d.productTitle,
      "Customer name": d.customerName ?? "",
      "Customer email": d.customerEmail ?? "",
      // A single-line Flow field: newlines flattened, kept short.
      Description: (d.description ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
      "Admin URL": d.adminUrl ?? "",
    }),
  },
  repair_status_changed: {
    flowHandle: "shopcare-repair-status",
    klaviyoMetric: "ShopCare Repair Status Changed",
    recordKey: (d) => `ticket_${d.ticketId}:${d.status}`,
    fields: (d) => ({
      "Ticket number": String(d.ticketId),
      Status: humanizeStatus(d.status),
      "Product title": d.productTitle,
    }),
  },
  care_activated: {
    flowHandle: "shopcare-care-activated",
    klaviyoMetric: "ShopCare Care Activated",
    recordKey: (d) => `cover_${d.coverId}`,
    fields: (d) => ({
      "Care plan": d.carePlan,
      "Product title": d.productTitle,
      "Cover ends": d.coverEnds,
    }),
  },
  care_credit_offer: {
    flowHandle: "shopcare-care-credit",
    klaviyoMetric: "ShopCare Care Credit",
    recordKey: (d) => `cover_${d.coverId}`,
    fields: (d) => ({
      "Care plan": d.carePlan,
      "Product title": d.productTitle,
      "Credit code": d.creditCode,
      "Credit amount": d.creditAmount,
      "Credit expires": d.creditExpires,
    }),
  },
  care_offer: {
    flowHandle: "shopcare-care-offer",
    klaviyoMetric: "ShopCare Care Offer",
    recordKey: (d) => `order_${d.orderId}`,
    fields: (d) => ({
      "Product title": d.productTitle,
      "Care plan": d.carePlan,
      "Care price": d.carePrice,
      "Offer ends": d.offerEnds,
      "Add Care URL": d.addCareUrl,
    }),
  },
  quote_paid: {
    flowHandle: "shopcare-quote-paid",
    klaviyoMetric: "ShopCare Quote Paid",
    staffAlert: true,
    recordKey: (d) => `quotation_${d.quotationId}`,
    fields: (d) => ({ ...quoteBaseFields(d), "Order name": d.orderName }),
  },
  quote_declined: {
    flowHandle: "shopcare-quote-declined",
    klaviyoMetric: "ShopCare Quote Declined",
    staffAlert: true,
    recordKey: (d) => `quotation_${d.quotationId}`,
    fields: (d) => ({ ...quoteBaseFields(d), Reason: d.reason }),
  },
  quote_expired: {
    flowHandle: "shopcare-quote-expired",
    klaviyoMetric: "ShopCare Quote Expired",
    staffAlert: true,
    recordKey: (d) => `quotation_${d.quotationId}`,
    fields: (d) => ({ ...quoteBaseFields(d), "Valid until": d.validUntil }),
  },
  data_request: {
    flowHandle: "shopcare-data-request",
    staffAlert: true,
    recordKey: (d) => `request_${d.requestId}`,
    fields: (d) => ({
      "Request ID": d.requestId,
      Customer: d.customer,
      "Records found": d.summary,
      "Download URL": d.downloadUrl,
      "Admin URL": d.adminUrl,
    }),
  },
  trade_in_status_changed: {
    flowHandle: "shopcare-trade-in-status",
    klaviyoMetric: "ShopCare Trade-in Status Changed",
    recordKey: (d) => `trade_in_${d.tradeInId}:${d.status}`,
    fields: (d) => ({
      "Trade in number": String(d.tradeInId),
      Status: humanizeStatus(d.status),
      "Product title": d.productTitle,
      Credit: d.credit,
      Instructions: d.instructions,
      "Credit code": d.creditCode,
    }),
  },
};

export function isEventName(name: unknown): name is EventName {
  return typeof name === "string" && Object.hasOwn(EVENTS, name);
}

export function eventDefinition<E extends EventName>(
  event: E,
): EventDefinition<E> {
  return EVENTS[event];
}

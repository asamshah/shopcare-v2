/**
 * The notification events ShopCare emits, what each one carries, and which
 * channels it can go to. Ported from Rails `Notifications::Dispatcher::EVENTS`
 * (see "Notifications (v2 design)" in docs/PORTING.md).
 *
 * One event fans out to up to four channels, each its own delivery record:
 *   email        the customer email ShopCare sends itself
 *   staff_email  the staff alert ShopCare sends to "Notify staff at"
 *   flow         a Shopify Flow trigger (optional integration)
 *   klaviyo      a Klaviyo metric (optional integration)
 *
 * Callers pass typed event data; the Flow/Klaviyo fields (named exactly as in
 * extensions/shopcare-flow-* / parked/shopcare-flow-trade-in-status) and the
 * email template data are both derived from it here, so the three stay in step.
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
  /** Link to the ticket in the ShopCare admin, for the staff email. */
  adminUrl?: string | null;
}

export interface EventData {
  /** A storefront repair request was submitted (Repairs::IntakeSubmission). New in v2: emails only. */
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
  /** Flow/Klaviyo only (parked trigger); no ShopCare email yet. */
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

/** The emails ShopCare can send, each with its own on/off toggle, subject and intro. */
export const EMAIL_KINDS = [
  "repair_received",
  "repair_status_changed",
  "care_welcome",
  "care_credit_issued",
  "care_offer",
  "staff_repair_request",
  "staff_quote_paid",
  "staff_quote_declined",
  "staff_quote_expired",
] as const;

export type EmailKind = (typeof EMAIL_KINDS)[number];

/** Only this one needs marketing consent; the rest are transactional. */
export const MARKETING_EMAILS: readonly EmailKind[] = ["care_offer"];

export type Channel = "email" | "staff_email" | "flow" | "klaviyo";

/** The repair statuses customers are emailed about; "completed" reads as "returned". */
export const EMAILED_REPAIR_STATUSES = {
  assessing: "assessing",
  in_repair: "in_repair",
  ready: "ready",
  completed: "returned",
} as const satisfies Partial<Record<RepairStatus, string>>;

export type EmailedRepairStatus =
  (typeof EMAILED_REPAIR_STATUSES)[keyof typeof EMAILED_REPAIR_STATUSES];

export type FlowFields = Record<string, string | number>;

interface EventDefinition<E extends EventName> {
  /** Flow trigger handle and Klaviyo metric name (Rails EVENTS), when the event has them. */
  flowHandle?: string;
  klaviyoMetric?: string;
  /** Staff alerts: the Flow trigger has no customer reference, so it fires for guests too. */
  staffAlert?: boolean;
  customerEmail?: EmailKind;
  staffEmail?: EmailKind;
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
    customerEmail: "repair_received",
    staffEmail: "staff_repair_request",
    recordKey: (d) => `ticket_${d.ticketId}`,
    fields: (d) => ({
      "Ticket number": String(d.ticketId),
      "Product title": d.productTitle,
    }),
  },
  repair_status_changed: {
    flowHandle: "shopcare-repair-status",
    klaviyoMetric: "ShopCare Repair Status Changed",
    customerEmail: "repair_status_changed",
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
    customerEmail: "care_welcome",
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
    customerEmail: "care_credit_issued",
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
    customerEmail: "care_offer",
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
    staffEmail: "staff_quote_paid",
    recordKey: (d) => `quotation_${d.quotationId}`,
    fields: (d) => ({ ...quoteBaseFields(d), "Order name": d.orderName }),
  },
  quote_declined: {
    flowHandle: "shopcare-quote-declined",
    klaviyoMetric: "ShopCare Quote Declined",
    staffAlert: true,
    staffEmail: "staff_quote_declined",
    recordKey: (d) => `quotation_${d.quotationId}`,
    fields: (d) => ({ ...quoteBaseFields(d), Reason: d.reason }),
  },
  quote_expired: {
    flowHandle: "shopcare-quote-expired",
    klaviyoMetric: "ShopCare Quote Expired",
    staffAlert: true,
    staffEmail: "staff_quote_expired",
    recordKey: (d) => `quotation_${d.quotationId}`,
    fields: (d) => ({ ...quoteBaseFields(d), "Valid until": d.validUntil }),
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

/**
 * The customer email an event sends, if any. Repair status changes only email
 * for the statuses in EMAILED_REPAIR_STATUSES.
 */
export function customerEmailFor<E extends EventName>(
  event: E,
  data: EventData[E],
): EmailKind | undefined {
  if (event === "repair_status_changed") {
    const status = (data as EventData["repair_status_changed"]).status;
    if (!Object.hasOwn(EMAILED_REPAIR_STATUSES, status)) return undefined;
  }
  return EVENTS[event].customerEmail;
}

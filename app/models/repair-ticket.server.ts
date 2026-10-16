/**
 * A repair request and its workbench record. Port of RepairTicket.
 *
 * Status pipeline (docs/MERCHANT-ADMIN-SPEC.md §4):
 *   new → assessing → quoted → awaiting_item → received → in_repair → ready → completed
 *   quoted → quote_declined (the customer declined, or the quote expired)
 *   quoted → in_repair when the item was already received (itemReceivedAt)
 *   (+ cancelled / rejected terminal states)
 *
 * awaiting_item: the quote is paid (or £0 covered) and the customer has been
 * sent a postage slip; received: staff marked the parcel as arrived.
 *
 * Rails also emitted `repair_status_changed` after a status change commit
 * (`after_update_commit`). There are no callbacks here: callers that change
 * the status pass the result of `repairStatusChangedEvent` to the
 * notifications dispatcher (ported with the services).
 */
import type { Prisma, Quotation, RepairTicket } from "@prisma/client";
import prisma from "../db.server";
import type { Db } from "../lib/db-lock.server";
import { activeCover, type ItemWithCovers } from "./item.server";
import {
  assertValid,
  Errors,
  searchWhere,
  validateEmail,
  validateInclusion,
  validateMaxLength,
} from "./validation.server";

export const REPAIR_TICKET_STATUSES = [
  "new",
  "assessing",
  "quoted",
  "quote_declined",
  "awaiting_item",
  "received",
  "in_repair",
  "ready",
  "completed",
  "cancelled",
  "rejected",
] as const;
export type RepairTicketStatus = (typeof REPAIR_TICKET_STATUSES)[number];
export const CLOSED_STATUSES: readonly RepairTicketStatus[] = ["completed", "cancelled", "rejected"];

type Validatable = Pick<
  Prisma.RepairTicketUncheckedCreateInput,
  "status" | "customerEmail" | "description"
>;

export function validateRepairTicket(ticket: Validatable): Errors {
  const errors = new Errors();
  validateInclusion(errors, "status", ticket.status ?? "new", REPAIR_TICKET_STATUSES);
  validateEmail(errors, "customerEmail", ticket.customerEmail);
  validateMaxLength(errors, "description", ticket.description, 5000);
  return errors;
}

export async function createRepairTicket(
  data: Prisma.RepairTicketUncheckedCreateInput,
  db: Db = prisma,
): Promise<RepairTicket> {
  assertValid("RepairTicket", validateRepairTicket(data));
  return db.repairTicket.create({ data });
}

export async function updateRepairTicket(
  id: number,
  data: Prisma.RepairTicketUncheckedUpdateInput,
  db: Db = prisma,
): Promise<RepairTicket> {
  const current = await db.repairTicket.findUniqueOrThrow({ where: { id } });
  assertValid("RepairTicket", validateRepairTicket({ ...current, ...data } as Validatable));
  return db.repairTicket.update({ where: { id }, data });
}

/**
 * Where a paid (or £0 covered) quote moves the ticket: straight into repair
 * when the workshop already has the item, else waiting for the customer to
 * post it.
 */
export function statusAfterPayment(
  ticket: Pick<RepairTicket, "itemReceivedAt">,
): Extract<RepairTicketStatus, "awaiting_item" | "in_repair"> {
  return ticket.itemReceivedAt ? "in_repair" : "awaiting_item";
}

export function isClosed(ticket: Pick<RepairTicket, "status">): boolean {
  return (CLOSED_STATUSES as readonly string[]).includes(ticket.status);
}

/**
 * Links the ticket to an item and picks up whatever cover is in force now.
 * `inWarranty` is a cached flag so lists don't need a join. Returns the
 * attributes to save (Rails `assign_attributes`).
 */
export function linkItem(
  item: ItemWithCovers | null,
  at = new Date(),
): Pick<RepairTicket, "itemId" | "coverId" | "inWarranty"> {
  const cover = item ? activeCover(item, at) : null;
  return { itemId: item?.id ?? null, coverId: cover?.id ?? null, inWarranty: cover !== null };
}

/** The active (latest) quotation for the workbench. */
export function currentQuotation(ticketId: number, db: Db = prisma): Promise<Quotation | null> {
  return db.quotation.findFirst({
    where: { repairTicketId: ticketId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

/** Still being worked on: the storefront won't take a second request for its item. */
export const openWhere: Prisma.RepairTicketWhereInput = {
  status: { notIn: [...CLOSED_STATUSES] },
};

export const RECENT_ORDER: Prisma.RepairTicketOrderByWithRelationInput[] = [
  { createdAt: "desc" },
  { id: "desc" },
];

/** Rails `has_many :activities, -> { order(created_at: :desc) }`. */
export const ACTIVITIES_ORDER: Prisma.TicketActivityOrderByWithRelationInput = {
  createdAt: "desc",
};

/** Case-insensitive match across the fields the workbench search box covers. */
export function repairTicketSearchWhere(term: string, db: Db = prisma) {
  return searchWhere(
    db,
    "repair_tickets",
    ["customer_name", "customer_email", "product_title", "order_number"],
    term,
  );
}

export interface RepairStatusChangedEvent {
  event: "repair_status_changed";
  customerId: string | null;
  email: string | null;
  fields: Record<string, string>;
}

/**
 * The notification Rails sent when a ticket's status changed, or null when
 * there's nobody to tell.
 */
export function repairStatusChangedEvent(
  ticket: Pick<RepairTicket, "id" | "shopifyCustomerId" | "customerEmail" | "status" | "productTitle">,
): RepairStatusChangedEvent | null {
  if (!ticket.shopifyCustomerId?.trim() && !ticket.customerEmail?.trim()) return null;
  const status = ticket.status.replace(/_/g, " ");
  return {
    event: "repair_status_changed",
    customerId: ticket.shopifyCustomerId,
    email: ticket.customerEmail,
    fields: {
      "Ticket number": String(ticket.id),
      Status: status.charAt(0).toUpperCase() + status.slice(1).toLowerCase(),
      "Product title": ticket.productTitle ?? "",
    },
  };
}


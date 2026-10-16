/**
 * Moving a repair ticket through its pipeline (contract service, w2-backend).
 * Port of TicketsController#update_status plus RepairTicket's
 * `after_update_commit :notify_status_change`.
 *
 * `changeTicketStatus` accepts any known status other than the current one
 * (Rails: staff can advance or override the pipeline freely), then:
 *   - logs a status_change activity
 *   - sends the `status_change` outbound webhook
 *   - emits `repair_status_changed` (customer email / Flow / Klaviyo)
 *   - on "completed", when the workshop (parts) is on, takes the repair's
 *     parts out of stock and records its costs (consumeTicketParts)
 *   - on "cancelled", cancels the ticket's open quote and deletes its draft
 *     order (cancelOpenQuotesForTicket)
 *
 * The status is written under the ticket's row lock, so two staff changing it
 * at once each see the other's result.
 *
 * `notifyRepairStatusChanged` is the callback every other service that moves
 * a ticket calls after its commit (quote sent / paid / declined / revised).
 */
import type { RepairTicket, Shop } from "@prisma/client";
import prisma from "../../db.server";
import {
  REPAIR_TICKET_STATUSES,
  repairStatusChangedEvent,
  type RepairTicketStatus,
} from "../../models/repair-ticket.server";
import { partsEnabled } from "../../models/shop.server";
import { createTicketActivity } from "../../models/ticket-activity.server";
import type { RepairStatus } from "../notifications/events.server";
import { notify, type NotifyOptions } from "../notifications/notify.server";
import { consumeTicketParts } from "../parts/consumer.server";
import { cancelOpenQuotesForTicket } from "../quotes/cancel.server";
import {
  authorFor,
  clientFor,
  emitTicketWebhook,
  withLock,
  type Actor,
  type Result,
  type ServiceOptions,
} from "../quotes/common.server";

/** Rails after_update_commit: tell the customer their repair moved along. */
export async function notifyRepairStatusChanged(
  shop: Pick<Shop, "shopifyDomain">,
  ticket: Pick<
    RepairTicket,
    "id" | "shopifyCustomerId" | "customerEmail" | "customerName" | "status" | "productTitle"
  >,
  options?: NotifyOptions,
): Promise<void> {
  if (!repairStatusChangedEvent(ticket)) return;
  await notify(
    shop.shopifyDomain,
    "repair_status_changed",
    {
      customerId: ticket.shopifyCustomerId,
      email: ticket.customerEmail,
      name: ticket.customerName,
    },
    {
      ticketId: ticket.id,
      status: ticket.status as RepairStatus,
      productTitle: ticket.productTitle ?? "",
      customerName: ticket.customerName,
    },
    options,
  );
}

const humanStatus = (status: string) => status.replace(/_/g, " ");

export interface ChangeTicketStatusInput extends ServiceOptions {
  shopId: number;
  ticketId: number;
  to: string;
  actor: Actor;
  /** Optional staff note, appended to the activity. */
  note?: string | null;
}

export type ChangeTicketStatusResult = Result<{
  changed: boolean;
  /** The Rails flash notice, e.g. "Status updated to completed. 2 parts taken from stock." */
  message: string;
}>;

export async function changeTicketStatus({
  shopId,
  ticketId,
  to,
  actor,
  note,
  db = prisma,
  ...options
}: ChangeTicketStatusInput): Promise<ChangeTicketStatusResult> {
  if (!(REPAIR_TICKET_STATUSES as readonly string[]).includes(to))
    return { ok: false, error: "Unknown status." };
  const found = await db.repairTicket.findFirst({
    where: { id: ticketId, shopId },
    include: { shop: true },
  });
  if (!found) return { ok: false, error: "Ticket not found." };
  const shop = found.shop;

  const outcome = await withLock(db, "repair_tickets", ticketId, async (tx) => {
    const ticket = await tx.repairTicket.findUniqueOrThrow({ where: { id: ticketId } });
    const from = ticket.status;
    if (from === to) return { ticket, from, changed: false };
    const updated = await tx.repairTicket.update({
      where: { id: ticketId },
      data: { status: to as RepairTicketStatus },
    });
    const extra = note?.trim() ? ` ${note.trim()}` : "";
    await createTicketActivity(
      {
        repairTicketId: ticketId,
        activityType: "status_change",
        author: authorFor(actor),
        body: `Status changed from ${from} to ${to}.${extra}`,
      },
      tx,
    );
    return { ticket: updated, from, changed: true };
  });

  if (!outcome.changed) return { ok: true, changed: false, message: "" };

  await emitTicketWebhook(shop, ticketId, "status_change", to, options);
  await notifyRepairStatusChanged(shop, outcome.ticket, {
    db,
    deps: options.notifyDeps,
  });

  let message = `Status updated to ${humanStatus(to)}.`;
  if (to === "completed" && partsEnabled(shop)) {
    const client = await clientFor(shop, options.client);
    const result = await consumeTicketParts(outcome.ticket, {
      by: actor,
      client,
      db,
      now: options.now,
    });
    if (result.consumed.length > 0) {
      const n = result.consumed.length;
      message += ` ${n} ${n === 1 ? "part" : "parts"} taken from stock.`;
    }
    if (result.skipped.length > 0) {
      message += ` Not taken from stock (no variant chosen): ${result.skippedNames}.`;
    }
  }
  if (to === "cancelled") {
    const cancelled = await cancelOpenQuotesForTicket({
      shopId,
      ticketId,
      actor,
      db,
      ...options,
    });
    if (cancelled.ok && cancelled.note) message += ` ${cancelled.note}`;
  }
  return { ok: true, changed: true, message };
}

/**
 * Staff "Mark returned": the repaired item is posted back to the customer.
 *
 * Fulfils the ticket's paid repair order in Shopify with the tracking details
 * and notifyCustomer: true, so Shopify sends its own Shipping confirmation
 * email (with the tracking link) from the store. Then the ticket moves to
 * completed ("Returned" on the storefront), which also takes its parts out
 * of stock and fires the status-change webhook / Flow trigger like any other
 * completion.
 *
 * Needs a paid quote with a Shopify order (paid invoice or a completed £0
 * draft order); a ticket without one is completed with the status picker and
 * the customer told some other way.
 */
import prisma from "../../db.server";
import { createTicketActivity } from "../../models/ticket-activity.server";
import { fulfilOrderWithTracking, NothingToFulfilError, type Tracking } from "../../shopify/fulfillments.server";
import { authorFor, clientFor, errorMessage, type Actor, type Result, type ServiceOptions } from "../quotes/common.server";
import { changeTicketStatus } from "./ticket-status.server";

/** Statuses a ticket can be returned from. */
export const RETURNABLE_STATUSES = ["received", "in_repair", "ready"] as const;

export interface ReturnItemInput extends ServiceOptions {
  shopId: number;
  ticketId: number;
  actor: Actor;
  tracking: Tracking;
}

export async function returnRepairedItem({
  shopId,
  ticketId,
  actor,
  tracking,
  db = prisma,
  ...options
}: ReturnItemInput): Promise<Result<{ message: string }>> {
  const ticket = await db.repairTicket.findFirst({ where: { id: ticketId, shopId }, include: { shop: true } });
  if (!ticket) return { ok: false, error: "Ticket not found." };
  if (!(RETURNABLE_STATUSES as readonly string[]).includes(ticket.status))
    return { ok: false, error: `A ${ticket.status.replace(/_/g, " ")} ticket can't be marked as returned.` };
  if (!tracking.number?.trim() && !tracking.url?.trim())
    return { ok: false, error: "Add the tracking number (or a tracking link) so Shopify can email it to the customer." };
  if (tracking.url?.trim() && !/^https?:\/\/\S+$/i.test(tracking.url.trim()))
    return { ok: false, error: "The tracking link must be a full web address (https://…)." };
  const quotation = await db.quotation.findFirst({
    where: { repairTicketId: ticket.id, status: "paid", shopifyOrderId: { not: null } },
    orderBy: [{ paidAt: "desc" }, { id: "desc" }],
  });
  if (!quotation?.shopifyOrderId)
    return {
      ok: false,
      error: "This repair has no paid Shopify order to fulfil. Set the status to Completed and tell the customer yourself.",
    };

  const client = await clientFor(ticket.shop, options.client);
  let orderName: string;
  try {
    ({ orderName } = await fulfilOrderWithTracking(client, quotation.shopifyOrderId, tracking));
  } catch (error) {
    if (error instanceof NothingToFulfilError) return { ok: false, error: `${error.message} Fulfil it in Shopify, or set the status to Completed.` };
    (options.logger ?? console).error(`[repairs/return-item] ticket=${ticket.id} ${errorMessage(error)}`);
    return { ok: false, error: `Shopify couldn't fulfil the order: ${errorMessage(error)}` };
  }

  const trackingText = [tracking.company?.trim(), tracking.number?.trim()].filter(Boolean).join(" ") || tracking.url?.trim();
  await createTicketActivity(
    {
      repairTicketId: ticket.id,
      activityType: "system",
      author: authorFor(actor),
      body: `Item posted back (${trackingText}). Order ${orderName} fulfilled: Shopify emailed the customer its shipping confirmation.`,
    },
    db,
  );
  const moved = await changeTicketStatus({ shopId, ticketId, to: "completed", actor, db, ...options });
  const extra = moved.ok && moved.message.includes("part") ? ` ${moved.message.replace(/^Status updated to completed\. ?/, "")}` : "";
  return { ok: true, message: `Marked as returned. Shopify emailed the customer the tracking details.${extra}` };
}

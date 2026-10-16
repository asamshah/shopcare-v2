/**
 * Getting the customer's item to the workshop (V1: the customer pays their
 * own postage).
 *
 *   requestItemByPost   when a ticket enters awaiting_item (quote paid, or a
 *                       £0 covered quote completed): emails the customer
 *                       "Send your item to us" with the postage slip
 *                       attached and a signed download link. Queued once per
 *                       ticket (send number 1); a ticket that comes back to
 *                       awaiting_item doesn't email again.
 *   resendPostageEmail  staff "Resend postage email": a new send number, so
 *                       a new delivery.
 *   notifyItemReceived  staff marked the parcel as arrived: "We've received
 *                       your item" (once per ticket).
 *
 * Without a workshop address (Settings → Repairs) nothing is sent: the ticket
 * gets an activity saying so, and staff resend once the address is in.
 */
import type { RepairTicket, Shop } from "@prisma/client";
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import {
  completeWorkshopAddress,
  postingInstructions,
  repairStatusUrl,
  workshopAddressLines,
} from "../../models/shop.server";
import { createTicketActivity } from "../../models/ticket-activity.server";
import { isEmailEnabled } from "../notifications/settings.server";
import { loadNotificationSettings } from "../notifications/shop-settings.server";
import { notify, type NotifyOptions } from "../notifications/notify.server";
import { MISSING_WORKSHOP_ADDRESS, postageSlipLink } from "./postage-slip.server";

type ItemShop = Pick<Shop, "id" | "shopifyDomain" | "settings">;
type ItemTicket = Pick<
  RepairTicket,
  "id" | "shopifyCustomerId" | "customerEmail" | "customerName" | "productTitle"
>;

export interface PostageOptions extends NotifyOptions {
  db?: Db;
  now?: Date;
}

export type PostageOutcome = "queued" | "no_email" | "no_address" | "turned_off";

async function emitItemRequested(
  shop: ItemShop,
  ticket: ItemTicket,
  sendNumber: number,
  { db = prisma, now = new Date(), ...options }: PostageOptions,
): Promise<PostageOutcome> {
  const workshop = completeWorkshopAddress(shop);
  if (!workshop) return "no_address";
  if (!ticket.customerEmail?.trim()) return "no_email";
  const settings = await loadNotificationSettings(shop.shopifyDomain, db);
  if (!settings || !isEmailEnabled(settings, "send_item")) return "turned_off";
  await notify(
    shop.shopifyDomain,
    "item_requested",
    { customerId: ticket.shopifyCustomerId, email: ticket.customerEmail, name: ticket.customerName },
    {
      ticketId: ticket.id,
      productTitle: ticket.productTitle ?? "",
      customerName: ticket.customerName,
      workshopAddress: workshopAddressLines(workshop),
      instructions: postingInstructions(shop),
      downloadUrl: postageSlipLink(shop, ticket.id, { now }),
      sendNumber,
    },
    { db, ...options },
  );
  return "queued";
}

const OUTCOME_NOTE: Record<Exclude<PostageOutcome, "queued">, string> = {
  no_address: `Postage slip not sent: ${MISSING_WORKSHOP_ADDRESS} Then use "Resend postage email".`,
  no_email: "Postage slip not sent: the customer has no email address. Download it from the ticket and send it to them.",
  turned_off:
    'Postage slip not emailed: the "Send your item to us" email is switched off in Settings → Notifications.',
};

/**
 * The ticket just entered awaiting_item: ask the customer to post the item.
 * Runs once per ticket (claims send number 1); later calls do nothing.
 */
export async function requestItemByPost(
  shop: ItemShop,
  ticket: ItemTicket,
  options: PostageOptions = {},
): Promise<PostageOutcome | "already_requested"> {
  const db = options.db ?? prisma;
  const claimed = await db.repairTicket.updateMany({
    where: { id: ticket.id, postageEmailsSent: 0 },
    data: { postageEmailsSent: 1 },
  });
  if (claimed.count === 0) return "already_requested";
  const outcome = await emitItemRequested(shop, ticket, 1, options);
  if (outcome !== "queued") {
    // Nothing went out: let "Resend postage email" use send number 1.
    await db.repairTicket.update({ where: { id: ticket.id }, data: { postageEmailsSent: 0 } });
  }
  await createTicketActivity(
    {
      repairTicketId: ticket.id,
      activityType: "system",
      author: "system",
      body:
        outcome === "queued"
          ? "Postage slip emailed: asked the customer to send the item."
          : OUTCOME_NOTE[outcome],
    },
    db,
  );
  return outcome;
}

/** Staff "Resend postage email": a fresh email (and slip) for a ticket awaiting its item. */
export async function resendPostageEmail(
  shop: ItemShop,
  ticketId: number,
  options: PostageOptions = {},
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const db = options.db ?? prisma;
  const ticket = await db.repairTicket.findFirst({ where: { id: ticketId, shopId: shop.id } });
  if (!ticket) return { ok: false, error: "Ticket not found." };
  if (ticket.status !== "awaiting_item")
    return { ok: false, error: "Only tickets awaiting the customer's item have a postage email." };
  if (!completeWorkshopAddress(shop)) return { ok: false, error: MISSING_WORKSHOP_ADDRESS };
  if (!ticket.customerEmail?.trim()) return { ok: false, error: OUTCOME_NOTE.no_email };

  const { postageEmailsSent: sendNumber } = await db.repairTicket.update({
    where: { id: ticket.id },
    data: { postageEmailsSent: { increment: 1 } },
    select: { postageEmailsSent: true },
  });
  const outcome = await emitItemRequested(shop, ticket, sendNumber, options);
  if (outcome !== "queued") {
    await db.repairTicket.update({ where: { id: ticket.id }, data: { postageEmailsSent: { decrement: 1 } } });
    return { ok: false, error: OUTCOME_NOTE[outcome] };
  }
  await createTicketActivity(
    {
      repairTicketId: ticket.id,
      activityType: "system",
      author: "staff",
      body: `Postage email sent again to ${ticket.customerEmail}.`,
    },
    db,
  );
  return { ok: true, message: `Postage email sent again to ${ticket.customerEmail}.` };
}

/** "We've received your item" (once per ticket). */
export async function notifyItemReceived(
  shop: Pick<Shop, "shopifyDomain" | "settings">,
  ticket: ItemTicket,
  options: NotifyOptions = {},
): Promise<void> {
  if (!ticket.shopifyCustomerId?.trim() && !ticket.customerEmail?.trim()) return;
  await notify(
    shop.shopifyDomain,
    "item_received",
    { customerId: ticket.shopifyCustomerId, email: ticket.customerEmail, name: ticket.customerName },
    {
      ticketId: ticket.id,
      productTitle: ticket.productTitle ?? "",
      customerName: ticket.customerName,
      statusUrl: repairStatusUrl(shop),
    },
    options,
  );
}

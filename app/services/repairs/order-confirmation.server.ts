/**
 * What a repair order carries for Shopify's own Order confirmation email.
 *
 * ShopCare sends no email itself: the customer's "send your item to us"
 * message is a section the merchant pastes into Settings → Notifications →
 * Order confirmation (app/services/emails/order-confirmation.liquid). That
 * email is sent the moment the order is created, before any webhook reaches
 * ShopCare, so everything it shows must already be on the draft order when it
 * is paid or completed. These are written as the draft order's custom
 * attributes, which become the order's attributes and are readable in
 * notification templates as `attributes.<key>`:
 * https://help.shopify.com/en/manual/fulfillment/setup/notifications/email-variables
 * (Draft-order metafields aren't documented as copied to the order, so they
 * aren't used.)
 *
 * The postage slip link is signed for the quote's validity plus
 * POSTAGE_LINK_DAYS, so it still works for a customer who pays on the last
 * day. The download route only serves it while the ticket awaits its item.
 */
import type { RepairTicket, Shop } from "@prisma/client";
import {
  completeWorkshopAddress,
  postingInstructions,
  quoteValidDays,
  repairStatusUrl,
  workshopAddressLines,
} from "../../models/shop.server";
import { POSTAGE_LINK_DAYS, postageSlipLink } from "./postage-slip.server";

/** Every repair order is tagged with this, besides the merchant's own order tag. */
export const REPAIR_ORDER_TAG = "shopcare-repair";

/** The attribute keys the order confirmation snippet reads. */
export const ORDER_ATTRIBUTE_KEYS = {
  quotationId: "repair_quotation_id",
  ticketId: "repair_ticket_id",
  postageSlipUrl: "shopcare_postage_slip_url",
  statusUrl: "shopcare_status_url",
  workshopAddress: "shopcare_workshop_address",
  postingInstructions: "shopcare_posting_instructions",
  itemReceived: "shopcare_item_received",
} as const;

export interface OrderAttribute {
  key: string;
  value: string;
}

/**
 * The attributes after the quotation and ticket ids. No slip link and no
 * workshop address without a complete workshop address (the snippet then
 * asks the customer to wait to hear from the shop); none of the posting
 * details when the workshop already has the item.
 */
export function orderConfirmationAttributes(
  shop: Pick<Shop, "shopifyDomain" | "settings">,
  ticket: Pick<RepairTicket, "id" | "itemReceivedAt">,
  now: Date = new Date(),
): OrderAttribute[] {
  const k = ORDER_ATTRIBUTE_KEYS;
  const attributes: OrderAttribute[] = [];
  const statusUrl = repairStatusUrl(shop);
  if (statusUrl) attributes.push({ key: k.statusUrl, value: statusUrl });
  if (ticket.itemReceivedAt) {
    attributes.push({ key: k.itemReceived, value: "yes" });
    return attributes;
  }
  const workshop = completeWorkshopAddress(shop);
  if (!workshop) return attributes;
  attributes.push(
    {
      key: k.postageSlipUrl,
      value: postageSlipLink(shop, ticket.id, { now, days: quoteValidDays(shop) + POSTAGE_LINK_DAYS }),
    },
    { key: k.workshopAddress, value: workshopAddressLines(workshop).join("\n") },
    { key: k.postingInstructions, value: postingInstructions(shop) },
  );
  return attributes;
}

/**
 * The product cards the storefront repair form offers: a past purchase or a
 * registered product, with the cover it carries (Care, warranty or none) and
 * any repair already open for it, so it can't be requested twice. Shared by
 * /proxy/orders (order history) and /proxy/order_lookup (an order found by
 * number). Port of Repairs::ProductCards; JSON keys as Rails.
 */
import type { Cover, RepairTicket } from "@prisma/client";
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import {
  coverBadgeLabel,
  coverName,
  coverOutcomeLabel,
} from "../../models/cover.server";
import { activeCover, type ItemWithCovers } from "../../models/item.server";
import { openWhere } from "../../models/repair-ticket.server";
import { statutoryRightsNotice } from "../../models/statutory-rights.server";
import { compact, iso8601, isoDate, statusLabel } from "./json.server";

/** The fields a card starts from (Rails `fields`), in Rails key order. */
export interface CardFields {
  product_id?: string | null;
  variant_id?: string | null;
  product_title?: string | null;
  variant_title?: string | null;
  image_url?: string | null;
  order_name?: string | null;
  order_date?: string | null;
  order_id?: string | null;
  order_line_id?: string | null;
}

export interface CoverJson {
  kind: string;
  name: string;
  badge: string;
  outcome: string;
  ends_at: string;
  statutory_rights: string;
}

/** A cover as the storefront shows it (also used by /proxy/status). */
export function coverJson(cover: Cover): CoverJson {
  return {
    kind: cover.kind,
    name: coverName(cover),
    badge: coverBadgeLabel(cover),
    outcome: coverOutcomeLabel(cover),
    ends_at: isoDate(cover.endsAt)!,
    statutory_rights: statutoryRightsNotice(cover.kind === "care" ? "plan" : "warranty"),
  };
}

const purchaseKey = (orderName: unknown, variantId: unknown) =>
  JSON.stringify([orderName ?? null, variantId ?? null]);

export class ProductCards {
  private constructor(
    private openByItem: Map<number, RepairTicket>,
    private openByPurchase: Map<string, RepairTicket>,
    private now: Date,
  ) {}

  /** `items`: the Items the cards may be for; `customerId`: for older tickets raised before their item was recorded. */
  static async load(
    shop: { id: number },
    items: { id: number }[],
    customerId: string | null | undefined,
    { db = prisma, now = new Date() }: { db?: Db; now?: Date } = {},
  ): Promise<ProductCards> {
    const byItem = new Map<number, RepairTicket>();
    if (items.length) {
      const tickets = await db.repairTicket.findMany({
        where: { shopId: shop.id, ...openWhere, itemId: { in: items.map((i) => i.id) } },
        orderBy: { id: "asc" },
      });
      for (const ticket of tickets) byItem.set(ticket.itemId!, ticket); // index_by: last wins
    }
    const byPurchase = new Map<string, RepairTicket>();
    if (customerId) {
      const tickets = await db.repairTicket.findMany({
        where: { shopId: shop.id, ...openWhere, shopifyCustomerId: String(customerId), itemId: null },
        orderBy: { id: "asc" },
      });
      for (const ticket of tickets)
        byPurchase.set(purchaseKey(ticket.orderNumber, ticket.variantId), ticket);
    }
    return new ProductCards(byItem, byPurchase, now);
  }

  /** A card from `fields` (already compacted by the caller) and its Item, if recorded. */
  card(fields: CardFields, item: ItemWithCovers | null | undefined) {
    const ticket =
      (item && this.openByItem.get(item.id)) ||
      this.openByPurchase.get(purchaseKey(fields.order_name, fields.variant_id)) ||
      null;
    const cover = item ? activeCover(item, this.now) : null;
    return compact({
      ...fields,
      item_id: item?.id,
      cover: cover ? coverJson(cover) : null,
      open_ticket: ticket
        ? { id: ticket.id, status: ticket.status, status_label: statusLabel(ticket.status) }
        : null,
    });
  }

  registered(item: ItemWithCovers) {
    return this.card(
      compact({
        product_id: item.productId,
        variant_id: item.variantId,
        product_title: item.productTitle,
        variant_title: item.variantTitle,
        order_name: "Registered",
        order_date: iso8601(item.purchasedAt),
      }),
      item,
    );
  }
}

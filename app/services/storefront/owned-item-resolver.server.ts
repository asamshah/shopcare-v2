/**
 * Finds the Item a storefront customer is asking about: one they picked from
 * their purchase history (by order line) or a product they registered (by item
 * id), making sure it's theirs. Old orders recorded before the app was
 * installed are imported on demand. Port of Items::OwnedItemResolver.
 */
import type { Item } from "@prisma/client";
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import {
  COVERS_ORDER,
  forCustomerWhere,
  type ItemWithCovers,
} from "../../models/item.server";

export interface OrderImporterLike {
  importOrder(orderId: string, customerId: string | null | undefined): Promise<Item[]>;
}

export interface ItemResolver {
  resolve(ids: {
    itemId?: string | null;
    orderId?: string | null;
    orderLineId?: string | null;
  }): Promise<ItemWithCovers | null>;
}

const present = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value.trim() !== "";

export class OwnedItemResolver implements ItemResolver {
  private customerId: string | null;

  constructor(
    private shop: { id: number },
    customerId: string | null | undefined,
    /** Built only when an order has to be imported. */
    private importer: () => Promise<OrderImporterLike>,
    private db: Db = prisma,
  ) {
    this.customerId = present(customerId ?? null) ? String(customerId) : null;
  }

  async resolve({
    itemId,
    orderId,
    orderLineId,
  }: {
    itemId?: string | null;
    orderId?: string | null;
    orderLineId?: string | null;
  }): Promise<ItemWithCovers | null> {
    if (this.customerId === null) return null;

    if (present(itemId)) {
      if (!/^\d+$/.test(itemId.trim())) return null;
      return this.db.item.findFirst({
        where: { ...this.owned(), id: Number(itemId.trim()) },
        include: { covers: { orderBy: COVERS_ORDER } },
      });
    }
    if (!present(orderLineId)) return null;

    const found = await this.byLine(orderLineId);
    if (found || !present(orderId)) return found;
    const imported = await (await this.importer()).importOrder(orderId, this.customerId);
    return imported.length > 0 ? this.byLine(orderLineId) : null;
  }

  private owned() {
    return { shopId: this.shop.id, status: "active", ...forCustomerWhere(this.customerId) };
  }

  private byLine(orderLineId: string): Promise<ItemWithCovers | null> {
    return this.db.item.findFirst({
      where: { ...this.owned(), orderLineId: String(orderLineId) },
      include: { covers: { orderBy: COVERS_ORDER } },
      orderBy: { unitIndex: "asc" },
    });
  }
}

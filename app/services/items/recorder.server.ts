/**
 * Turns a paid order into Items (one per physical unit bought) and gives each
 * the warranty cover its shop's policies grant. Idempotent: re-recording an
 * order (webhook retry, backfill) leaves existing Items alone. Port of
 * Items::Recorder.
 *
 * Skipped: the shop's own repair orders (quotes paid through draft orders),
 * gift cards, and anything that doesn't ship (digital goods, services). Care
 * plan lines aren't items: they become Care cover on the items they were
 * bought for (CareActivator).
 */
import type { Item, Shop } from "@prisma/client";
import prisma from "../../db.server";
import { inTransaction, isUniqueViolation, type Db } from "../../lib/db-lock.server";
import { createItem } from "../../models/item.server";
import { repairOrderTag } from "../../models/shop.server";
import type { OrderData, OrderLine } from "../../shopify/orders.server";
import { CareActivator, type ActivationResult } from "../care/activator.server";
import {
  CoverAssigner,
  type ProductFactsSource,
} from "../warranty/cover-assigner.server";

export const MAX_UNITS_PER_LINE = 20;

type RecorderShop = Pick<Shop, "id" | "shopifyDomain" | "settings">;

export interface RecorderOptions {
  /** Product facts for warranty/Care eligibility (ProductFactsLoader). */
  facts?: ProductFactsSource | null;
  coverAssigner?: CoverAssigner;
  careActivator?: CareActivator;
  db?: Db;
}

export class ItemRecorder {
  /** Care covers created by the last record() call. */
  careResult: ActivationResult = { covers: [], unmatched: [] };
  private assigner: CoverAssigner;
  private activator: CareActivator;
  private db: Db;

  constructor(private shop: RecorderShop, options: RecorderOptions = {}) {
    this.db = options.db ?? prisma;
    this.assigner =
      options.coverAssigner ?? new CoverAssigner(shop, options.facts ?? null, this.db);
    this.activator = options.careActivator ?? new CareActivator(shop, this.db);
  }

  /** Returns the Items created by this call (not ones that already existed). */
  async record(order: OrderData): Promise<Item[]> {
    this.careResult = { covers: [], unmatched: [] };
    if (this.skipOrder(order)) return [];

    const items: Item[] = [];
    for (const line of order.lines) {
      if (!(await this.trackable(line))) continue;
      const units = Math.min(line.quantity, MAX_UNITS_PER_LINE);
      for (let unitIndex = 0; unitIndex < units; unitIndex++) {
        const item = await this.recordUnit(order, line, unitIndex);
        if (item) items.push(item);
      }
    }
    this.careResult = await this.activator.activate(order);
    return items;
  }

  private skipOrder(order: OrderData): boolean {
    return (
      !order.id ||
      order.tags.includes(repairOrderTag(this.shop).toLowerCase()) ||
      (!order.customerId && !order.email)
    );
  }

  private async trackable(line: OrderLine): Promise<boolean> {
    return (
      Boolean(line.productId) &&
      line.requiresShipping &&
      !line.giftCard &&
      line.quantity > 0 &&
      !(await this.activator.isCareLine(line))
    );
  }

  private async recordUnit(
    order: OrderData,
    line: OrderLine,
    unitIndex: number,
  ): Promise<Item | null> {
    const exists = await this.db.item.findFirst({
      where: { shopId: this.shop.id, orderLineId: line.id, unitIndex },
      select: { id: true },
    });
    if (exists) return null;

    // Ask Shopify (if needed) before the transaction, not inside it.
    const facts = await this.assigner.factsFor(line.productId);
    try {
      return await inTransaction(this.db, async (tx) => {
        const item = await createItem(
          {
            shopId: this.shop.id,
            source: "order",
            shopifyCustomerId: order.customerId,
            customerEmail: order.email,
            customerName: order.customerName,
            productId: line.productId,
            variantId: line.variantId,
            productTitle: line.title.trim() ? line.title : "Product",
            variantTitle: line.variantTitle,
            sku: line.sku,
            orderId: order.id,
            orderName: order.name,
            orderLineId: line.id,
            unitIndex,
            purchasedAt: order.processedAt ?? new Date(),
            unitPrice: line.unitPrice,
          },
          tx,
        );
        await this.assigner.assign(item, { facts, db: tx });
        return tx.item.findUniqueOrThrow({ where: { id: item.id } });
      });
    } catch (error) {
      if (isUniqueViolation(error)) return null; // a concurrent delivery of the same webhook got there first
      throw error;
    }
  }
}

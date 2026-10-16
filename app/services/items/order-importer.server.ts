/**
 * Pulls orders from Shopify and records their Items: one order on demand (a
 * customer picks an old purchase in the repair form), or every paid order in
 * the window `read_orders` allows (the post-install backfill). Port of
 * Items::OrderImporter; the Shopify reads are fetchCustomerOrder /
 * fetchRecentPaidOrders in app/shopify/orders.server.ts.
 */
import type { Item } from "@prisma/client";
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import { errorSummary, type AdminGraphqlClient } from "../../shopify/graphql.server";
import {
  fetchCustomerOrder,
  fetchRecentPaidOrders,
} from "../../shopify/orders.server";
import type { ItemRecorder } from "./recorder.server";

export const BACKFILL_DAYS = 60;

export class OrderImporter {
  constructor(
    private shop: { id: number; shopifyDomain: string },
    private client: AdminGraphqlClient,
    private recorder: ItemRecorder,
    private db: Db = prisma,
    private logger: Pick<Console, "error"> = console,
  ) {}

  /**
   * Records one order, but only if it belongs to `customerId` (a storefront
   * customer must not be able to claim someone else's order). Returns the
   * order's Items (new and existing), or [] if it isn't theirs. Never throws.
   */
  async importOrder(orderId: string, customerId: string | null | undefined): Promise<Item[]> {
    try {
      const order = await fetchCustomerOrder(this.client, orderId, customerId);
      if (!order) return [];
      await this.recorder.record(order);
      return this.db.item.findMany({
        where: { shopId: this.shop.id, orderId: order.id },
        orderBy: [{ orderLineId: "asc" }, { unitIndex: "asc" }],
      });
    } catch (error) {
      this.logger.error(
        `[items/order-importer] order ${orderId} for ${this.shop.shopifyDomain}: ${errorSummary(error)}`,
      );
      return [];
    }
  }

  /**
   * Records Items for every paid order processed since `since`. Returns the
   * number of Items created. Errors propagate so the job can retry.
   */
  async importRecent(
    since: Date = new Date(Date.now() - BACKFILL_DAYS * 86_400_000),
  ): Promise<number> {
    let created = 0;
    for await (const page of fetchRecentPaidOrders(this.client, since)) {
      for (const order of page) created += (await this.recorder.record(order)).length;
    }
    return created;
  }
}

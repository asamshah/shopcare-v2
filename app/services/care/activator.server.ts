/**
 * Turns the Care lines of a paid order into Care cover on the right items.
 * Port of Care::Activator. The storefront blocks tag each Care line with a
 * hidden property:
 *   _shopcare_for  = the variant id of the product it was bought with
 *                    (also a nested cart line under it), or
 *   _shopcare_item = an item the customer already owns ("add Care later").
 *
 * Idempotent per Care line, also when the paid-order webhook and an order
 * import run at once: each unit of a Care line is one cover (unique on shop +
 * line + unit), and the order's items are row-locked while a line is matched,
 * so two runs can't both pick the same uncovered item. A Care line that can't
 * be matched is logged and reported so staff can sort it out.
 */
import { Prisma, type CarePlan, type Cover, type Shop } from "@prisma/client";
import prisma from "../../db.server";
import { inTransaction, isUniqueViolation, type Db } from "../../lib/db-lock.server";
import { careCoverFor, createCover, coverInForce } from "../../models/cover.server";
import {
  COVERS_ORDER,
  carePlansOnOffer,
  forCustomerWhere,
} from "../../models/item.server";
import type { OrderData, OrderLine } from "../../shopify/orders.server";

export const FOR_PROPERTY = "_shopcare_for";
export const ITEM_PROPERTY = "_shopcare_item";

export interface ActivationResult {
  covers: Cover[];
  unmatched: OrderLine[];
}

export class CareActivator {
  private plans?: Promise<Map<string, CarePlan>>;

  constructor(
    private shop: Pick<Shop, "id" | "shopifyDomain" | "settings">,
    private db: Db = prisma,
    private logger: Pick<Console, "warn"> = console,
  ) {}

  /** Care plans by their Shopify variant id (all plans, active or not, like Rails). */
  plansByVariant(): Promise<Map<string, CarePlan>> {
    return (this.plans ??= this.db.carePlan
      .findMany({ where: { shopId: this.shop.id } })
      .then((plans) => new Map(plans.map((plan) => [plan.shopifyVariantId, plan]))));
  }

  async isCareLine(line: OrderLine): Promise<boolean> {
    return (await this.plansByVariant()).has(String(line.variantId ?? ""));
  }

  async activate(order: OrderData): Promise<ActivationResult> {
    const covers: Cover[] = [];
    const unmatched: OrderLine[] = [];
    for (const line of order.lines) {
      if (!(await this.isCareLine(line))) continue;
      const { created, matched } = await this.activateLine(order, line);
      covers.push(...created);
      if (matched) continue;
      unmatched.push(line);
      this.logger.warn(
        `[care/activator] ${this.shop.shopifyDomain} order ${order.name}: no item for Care line ${line.id}`,
      );
    }
    return { covers, unmatched };
  }

  private async activateLine(
    order: OrderData,
    line: OrderLine,
  ): Promise<{ created: Cover[]; matched: boolean }> {
    const plan = (await this.plansByVariant()).get(String(line.variantId))!;
    try {
      return await inTransaction(this.db, async (tx) => {
        await this.lockItems(tx, order, line);
        const taken = (
          await tx.cover.findMany({
            where: { shopId: this.shop.id, shopifyLineItemId: line.id },
            select: { lineUnitIndex: true },
          })
        ).map((cover) => cover.lineUnitIndex);
        const created: Cover[] = [];
        for (let unit = 0; unit < line.quantity; unit++) {
          if (taken.includes(unit)) continue;
          const item = await this.targetItem(tx, order, line, plan);
          if (!item) return { created, matched: false };
          const draft = careCoverFor(item, plan, {
            orderId: order.id,
            lineItemId: line.id,
            pricePaid: line.unitPrice,
            shop: this.shop,
          });
          created.push(await createCover({ ...draft, lineUnitIndex: unit }, tx));
        }
        return { created, matched: true };
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { created: [], matched: true }; // a concurrent run covered it first
      throw error;
    }
  }

  /** The items this Care line could attach to, locked until it's matched. */
  private async lockItems(tx: Prisma.TransactionClient, order: OrderData, line: OrderLine) {
    const ownedId = itemIdProperty(line);
    await tx.$queryRaw`
      SELECT id FROM items
      WHERE shop_id = ${this.shop.id}
        AND (order_id = ${order.id} OR id = ${ownedId ?? -1})
      ORDER BY id FOR UPDATE`;
  }

  private async targetItem(
    tx: Prisma.TransactionClient,
    order: OrderData,
    line: OrderLine,
    plan: CarePlan,
  ) {
    const ownedId = itemIdProperty(line);
    if (line.properties[ITEM_PROPERTY]?.trim()) {
      return ownedId === null ? null : this.ownedItemOnOffer(tx, order, ownedId, plan);
    }
    const parentVariant = line.properties[FOR_PROPERTY]?.trim();
    const candidates = await tx.item.findMany({
      where: {
        shopId: this.shop.id,
        status: "active",
        orderId: order.id,
        ...(parentVariant ? { variantId: parentVariant } : {}),
      },
      include: { covers: { orderBy: COVERS_ORDER } },
      orderBy: [{ orderLineId: "asc" }, { unitIndex: "asc" }],
    });
    return (
      candidates.find(
        (item) => !item.covers.some((cover) => cover.kind === "care" && coverInForce(cover)),
      ) ?? null
    );
  }

  /** "Add Care later": the item must be the customer's and still on offer. */
  private async ownedItemOnOffer(
    tx: Prisma.TransactionClient,
    order: OrderData,
    itemId: number,
    plan: CarePlan,
  ) {
    const item = await tx.item.findFirst({
      where: { shopId: this.shop.id, id: itemId, AND: [forCustomerWhere(order.customerId)] },
      include: { covers: { orderBy: COVERS_ORDER } },
    });
    if (!item) return null;
    const at = order.processedAt ?? new Date();
    return carePlansOnOffer(item, [plan], at).length > 0 ? item : null;
  }
}

function itemIdProperty(line: OrderLine): number | null {
  const value = line.properties[ITEM_PROPERTY]?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : null;
}

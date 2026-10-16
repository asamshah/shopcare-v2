/**
 * One physical product a customer owns. Created from a paid order line, or
 * registered by the customer for purchases made outside Shopify. Cover
 * (warranty / Care), repair tickets and trade-ins hang off it. Port of Item.
 */
import type { CarePlan, Cover, Item, Prisma } from "@prisma/client";
import prisma from "../db.server";
import type { Db } from "../lib/db-lock.server";
import { addDays } from "../lib/dates";
import { coverDiscountPercent, coverInForce } from "./cover.server";
import {
  assertValid,
  Errors,
  jsonArray,
  searchWhere,
  validateInclusion,
  validatePresence,
} from "./validation.server";

export const ITEM_SOURCES = ["order", "registration"] as const;
export type ItemSource = (typeof ITEM_SOURCES)[number];
/** active · refunded (order line refunded) · void (registration rejected) · traded_in */
export const ITEM_STATUSES = ["active", "refunded", "void", "traded_in"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** Rails `has_many :covers, -> { order(starts_at: :desc, id: :desc) }`. */
export const COVERS_ORDER: Prisma.CoverOrderByWithRelationInput[] = [
  { startsAt: "desc" },
  { id: "desc" },
];

export type ItemWithCovers = Item & { covers: Cover[] };

export function validateItem(
  item: Pick<Prisma.ItemUncheckedCreateInput, "productTitle" | "source" | "status">,
): Errors {
  const errors = new Errors();
  validatePresence(errors, "productTitle", item.productTitle);
  validateInclusion(errors, "source", item.source ?? "order", ITEM_SOURCES);
  validateInclusion(errors, "status", item.status ?? "active", ITEM_STATUSES);
  return errors;
}

export async function createItem(data: Prisma.ItemUncheckedCreateInput, db: Db = prisma): Promise<Item> {
  assertValid("Item", validateItem(data));
  return db.item.create({ data });
}

export async function updateItem(
  id: number,
  data: Prisma.ItemUncheckedUpdateInput,
  db: Db = prisma,
): Promise<Item> {
  const current = await db.item.findUniqueOrThrow({ where: { id } });
  assertValid("Item", validateItem({ ...current, ...data } as Prisma.ItemUncheckedCreateInput));
  return db.item.update({ where: { id }, data });
}

/** The item with its covers, newest first. */
export function findItemWithCovers(id: number, db: Db = prisma): Promise<ItemWithCovers> {
  return db.item.findUniqueOrThrow({ where: { id }, include: { covers: { orderBy: COVERS_ORDER } } });
}

export function careCover(item: ItemWithCovers, at = new Date()): Cover | null {
  return item.covers.find((cover) => cover.kind === "care" && coverInForce(cover, at)) ?? null;
}

/** Ids of the Care plans this item was eligible for at purchase. */
export function eligibleCarePlanIds(item: Pick<Item, "eligibleCarePlanIds">): number[] {
  return jsonArray(item.eligibleCarePlanIds).map(Number);
}

/**
 * Care plans this item can still have added after purchase (within each
 * plan's offer window, and only if it has no Care yet).
 */
export function carePlansOnOffer<P extends CarePlan>(
  item: ItemWithCovers,
  plans: P[],
  at = new Date(),
): P[] {
  const purchasedAt = item.purchasedAt;
  if (item.status !== "active" || careCover(item, at) || !purchasedAt) return [];
  const eligible = eligibleCarePlanIds(item);
  return plans.filter(
    (plan) =>
      plan.active &&
      eligible.includes(plan.id) &&
      plan.offerWindowDays > 0 &&
      addDays(purchasedAt, plan.offerWindowDays) >= at,
  );
}

/**
 * The cover that applies at `at` (warranty or Care), best first: a bigger
 * discount wins, then the one that runs longest.
 */
export function activeCover(item: ItemWithCovers, at = new Date()): Cover | null {
  if (item.status !== "active") return null;
  let best: Cover | null = null;
  for (const cover of item.covers) {
    if (!coverInForce(cover, at)) continue;
    if (!best) {
      best = cover;
      continue;
    }
    const byDiscount = coverDiscountPercent(cover).comparedTo(coverDiscountPercent(best));
    if (byDiscount > 0 || (byDiscount === 0 && cover.endsAt > best.endsAt)) best = cover;
  }
  return best;
}

/** e.g. "Aria Boot — UK 7 / Black" */
export function itemLabel(item: Pick<Item, "productTitle" | "variantTitle">): string {
  const title = item.productTitle ?? "";
  if (!item.variantTitle?.trim() || item.variantTitle === "Default Title") return title;
  return `${title} — ${item.variantTitle}`;
}

/** Rails `scope :for_customer`: nothing for a blank customer id. */
export function forCustomerWhere(customerId: string | number | null | undefined): Prisma.ItemWhereInput {
  const id = customerId === null || customerId === undefined ? "" : String(customerId).trim();
  return id ? { shopifyCustomerId: id } : { id: { in: [] } };
}

/** Rails `scope :search`: case-insensitive across the list's columns. */
export function itemSearchWhere(term: string, db: Db = prisma) {
  return searchWhere(
    db,
    "items",
    ["customer_name", "customer_email", "product_title", "order_name", "sku"],
    term,
  );
}

export const RECENT_ORDER: Prisma.ItemOrderByWithRelationInput[] = [
  { createdAt: "desc" },
  { id: "desc" },
];

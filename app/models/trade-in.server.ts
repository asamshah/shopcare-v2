/**
 * A customer trading in something they own, for credit (parked for V2).
 *   pending_purchase  added on the product page; becomes `requested` when that
 *                     order is paid (or is ignored if it never is)
 *   requested         waiting for staff to approve
 *   approved          customer has been told to send the item
 *   received          the item arrived; staff grade it and issue the credit
 *   crediting         the credit is being issued in Shopify (guards against
 *                     issuing it twice)
 *   credited          credit issued (store credit or a discount code)
 *   rejected / cancelled
 * Port of TradeIn (`has_many_attached :photos` → `photos` jsonb of storage keys).
 */
import { Prisma, type TradeIn, type TradeInProgram } from "@prisma/client";
import prisma from "../db.server";
import type { Db } from "../lib/db-lock.server";
import { humanize } from "../lib/inflections";
import { findGrade } from "./trade-in-program.server";
import {
  assertValid,
  Errors,
  searchWhere,
  validateEmail,
  validateInclusion,
  validateMaxLength,
  validatePresence,
} from "./validation.server";

export const TRADE_IN_STATUSES = [
  "pending_purchase",
  "requested",
  "approved",
  "received",
  "crediting",
  "credited",
  "rejected",
  "cancelled",
] as const;
export type TradeInStatus = (typeof TRADE_IN_STATUSES)[number];
export const OPEN_STATUSES: readonly TradeInStatus[] = ["requested", "approved", "received", "crediting"];
export const TRADE_IN_SOURCES = ["pdp", "form"] as const;

export interface TradeInPhoto {
  key: string;
  filename: string;
  contentType: string;
  byteSize: number;
}

type Validatable = Pick<
  Prisma.TradeInUncheckedCreateInput,
  "status" | "source" | "productTitle" | "customerEmail" | "description" | "itemId"
>;

export async function validateTradeIn(t: Validatable, id: number | null, db: Db = prisma): Promise<Errors> {
  const errors = new Errors();
  const status = t.status ?? "requested";
  validateInclusion(errors, "status", status, TRADE_IN_STATUSES);
  validateInclusion(errors, "source", t.source ?? "form", TRADE_IN_SOURCES);
  validatePresence(errors, "productTitle", t.productTitle);
  validateEmail(errors, "customerEmail", t.customerEmail);
  validateMaxLength(errors, "description", t.description, 5000);
  // Backed by a partial unique index on item_id.
  if (t.itemId && (OPEN_STATUSES as readonly string[]).includes(status)) {
    const other = await db.tradeIn.findFirst({
      where: {
        itemId: t.itemId,
        status: { in: [...OPEN_STATUSES] },
        ...(id ? { NOT: { id } } : {}),
      },
      select: { id: true },
    });
    if (other) errors.add("base", "This item already has a trade-in in progress.");
  }
  return errors;
}

export async function createTradeIn(
  data: Prisma.TradeInUncheckedCreateInput,
  db: Db = prisma,
): Promise<TradeIn> {
  assertValid("TradeIn", await validateTradeIn(data, null, db));
  return db.tradeIn.create({ data });
}

export async function updateTradeIn(
  id: number,
  data: Prisma.TradeInUncheckedUpdateInput,
  db: Db = prisma,
): Promise<TradeIn> {
  const current = await db.tradeIn.findUniqueOrThrow({ where: { id } });
  assertValid("TradeIn", await validateTradeIn({ ...current, ...data } as Validatable, id, db));
  return db.tradeIn.update({ where: { id }, data });
}

export function gradeLabel(program: Pick<TradeInProgram, "grades"> | null, key: string | null): string {
  return (program && key ? findGrade(program, key)?.label : undefined) ?? humanize(String(key ?? ""));
}

export function tradeInCredit(t: Pick<TradeIn, "finalCredit" | "quotedCredit">): Prisma.Decimal {
  return new Prisma.Decimal(t.finalCredit ?? t.quotedCredit);
}

/** Product-page trade-ins whose order was never paid are left out of lists. */
export const visibleWhere: Prisma.TradeInWhereInput = { status: { not: "pending_purchase" } };
export const inProgressWhere: Prisma.TradeInWhereInput = { status: { in: [...OPEN_STATUSES] } };
export const RECENT_ORDER: Prisma.TradeInOrderByWithRelationInput[] = [
  { createdAt: "desc" },
  { id: "desc" },
];

export function tradeInSearchWhere(term: string, db: Db = prisma) {
  return searchWhere(
    db,
    "trade_ins",
    ["customer_name", "customer_email", "product_title", "order_name"],
    term,
  );
}

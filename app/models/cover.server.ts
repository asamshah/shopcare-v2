/**
 * The cover an item carries: a free warranty, or a paid Care plan. Terms are
 * snapshotted from the policy or plan when the cover is created, so later
 * edits never change what a customer already has. Port of Cover.
 */
import { Prisma, type CarePlan, type Cover, type Item, type Shop, type WarrantyPolicy } from "@prisma/client";
import prisma from "../db.server";
import { addMonths } from "../lib/dates";
import { type Db, inTransaction, withRowLock } from "../lib/db-lock.server";
import { humanize } from "../lib/inflections";
import { plainNumber } from "../lib/money";
import { badgeLabel as carePlanBadgeLabel, carePlanTermsSnapshot } from "./care-plan.server";
import {
  assertValid,
  d,
  type DecimalInput,
  Errors,
  jsonObject,
  validateInclusion,
} from "./validation.server";
import { warrantyTermsSnapshot } from "./warranty-policy.server";

export const COVER_KINDS = ["warranty", "care"] as const;
export type CoverKind = (typeof COVER_KINDS)[number];
export const COVER_STATUSES = ["active", "cancelled"] as const;
export type CoverStatus = (typeof COVER_STATUSES)[number];

type CoverItem = Pick<Item, "id" | "shopId" | "purchasedAt" | "productTitle">;

/** An unsaved cover (Rails `Cover.new`): create input plus the fields the helpers read. */
export type CoverDraft = Prisma.CoverUncheckedCreateInput & {
  kind: CoverKind;
  terms: Prisma.JsonObject;
  startsAt: Date;
  endsAt: Date;
};

/** Warranty cover for an item from a policy, starting at purchase (unsaved). */
export function warrantyCoverFor(
  item: CoverItem,
  policy: WarrantyPolicy,
  now = new Date(),
): CoverDraft {
  const startsAt = item.purchasedAt ?? now;
  return {
    shopId: item.shopId,
    itemId: item.id,
    kind: "warranty",
    warrantyPolicyId: policy.id,
    startsAt,
    endsAt: addMonths(startsAt, policy.months),
    terms: warrantyTermsSnapshot(policy),
  };
}

/**
 * Care cover for an item, running for the plan's term from the item's
 * purchase (so Care added later doesn't extend it). Unsaved.
 */
export function careCoverFor(
  item: CoverItem,
  plan: CarePlan,
  {
    orderId = null,
    lineItemId = null,
    pricePaid = null,
    shop = null,
    now = new Date(),
  }: {
    orderId?: string | null;
    lineItemId?: string | null;
    pricePaid?: DecimalInput | null;
    shop?: Pick<Shop, "settings"> | null;
    now?: Date;
  } = {},
): CoverDraft {
  const startsAt = item.purchasedAt ?? now;
  return {
    shopId: item.shopId,
    itemId: item.id,
    kind: "care",
    carePlanId: plan.id,
    startsAt,
    endsAt: addMonths(startsAt, plan.termMonths),
    terms: carePlanTermsSnapshot(plan, { product: item.productTitle, shop }),
    shopifyOrderId: orderId,
    shopifyLineItemId: lineItemId,
    pricePaid: pricePaid ?? plan.price,
  };
}

export function validateCover(
  cover: Pick<Prisma.CoverUncheckedCreateInput, "startsAt" | "endsAt" | "kind" | "status">,
): Errors {
  const errors = new Errors();
  validateInclusion(errors, "kind", cover.kind ?? "warranty", COVER_KINDS);
  validateInclusion(errors, "status", cover.status ?? "active", COVER_STATUSES);
  const startsAt = cover.startsAt ? new Date(cover.startsAt) : null;
  const endsAt = cover.endsAt ? new Date(cover.endsAt) : null;
  if (!startsAt) errors.add("startsAt", "can't be blank");
  if (!endsAt) errors.add("endsAt", "can't be blank");
  if (startsAt && endsAt && endsAt <= startsAt) errors.add("endsAt", "must be after the start");
  return errors;
}

export async function createCover(
  data: Prisma.CoverUncheckedCreateInput,
  db: Db = prisma,
): Promise<Cover> {
  assertValid("Cover", validateCover(data));
  return db.cover.create({ data });
}

export function coverInForce(cover: Cover, at = new Date()): boolean {
  return cover.status === "active" && cover.startsAt <= at && cover.endsAt > at;
}

export function coverExpired(cover: Pick<Cover, "endsAt">, at = new Date()): boolean {
  return cover.endsAt <= at;
}

export function coverName(cover: Pick<Cover, "terms" | "kind">): string {
  const name = jsonObject(cover.terms).name;
  return typeof name === "string" && name.trim() ? name : humanize(cover.kind);
}

/**
 * The discount on every quote line: warranty's percentage, or 100% for Care,
 * which covers all repairs (Care covers sold with per-service terms, before
 * Care became full repair cover, are honoured the same way).
 */
export function coverDiscountPercent(cover: Pick<Cover, "terms">): Prisma.Decimal {
  return d(jsonObject(cover.terms).discount_percent);
}

export function coverFree(cover: Pick<Cover, "terms">): boolean {
  return coverDiscountPercent(cover).gte(100);
}

export function coveredFaults(cover: Pick<Cover, "terms">): string[] {
  const faults = jsonObject(cover.terms).covered_faults;
  if (faults === null || faults === undefined) return [];
  return Array.isArray(faults) ? faults.map(String) : [String(faults)];
}

export function coverExcess(cover: Pick<Cover, "terms">): Prisma.Decimal {
  return d(jsonObject(cover.terms).excess);
}

/** "Free repair" / "25% off repairs" / "Free repairs" (Care). */
export function coverOutcomeLabel(cover: Pick<Cover, "terms" | "kind">): string {
  if (cover.kind === "care") return "Free repairs";
  return coverFree(cover)
    ? "Free repair"
    : `${plainNumber(coverDiscountPercent(cover))}% off repairs`;
}

/** The storefront badge: "ShopCare – 2 year plan" (Care), or the warranty's name. */
export function coverBadgeLabel(cover: Pick<Cover, "terms" | "kind">): string {
  return cover.kind === "care"
    ? carePlanBadgeLabel(Number(jsonObject(cover.terms).term_months))
    : coverName(cover);
}

export function claimsCount(cover: Pick<Cover, "usage">): number {
  return Math.trunc(Number(jsonObject(cover.usage).claims) || 0);
}

/** Counts a claim (a repair the cover paid for), under a row lock. */
export function recordClaim(coverId: number, db: Db = prisma): Promise<Cover> {
  return inTransaction(db, async (tx) => {
    await withRowLock(tx, "covers", coverId);
    const cover = await tx.cover.findUniqueOrThrow({ where: { id: coverId } });
    const usage = { ...jsonObject(cover.usage), claims: claimsCount(cover) + 1 };
    return tx.cover.update({ where: { id: coverId }, data: { usage } });
  });
}

export function cancelCover(coverId: number, db: Db = prisma): Promise<Cover> {
  return db.cover.update({ where: { id: coverId }, data: { status: "cancelled" } });
}


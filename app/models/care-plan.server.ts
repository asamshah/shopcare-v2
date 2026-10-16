/**
 * A paid Care plan: AppleCare-style cover the customer adds on the product
 * page. It's sold as a Care product the merchant creates in Shopify (linked
 * here by variant), and honoured as free repairs: a plan covers every repair
 * for its term, apart from the exclusions (and an excess per repair, if the
 * merchant sets one). There are no per-service limits.
 *
 * Guardrails: the brand repairs or replaces its own goods. Plans never cover
 * theft, loss or accidental damage, and never pay out cash. These are fixed
 * terms, not settings. Port of CarePlan.
 */
import type { CarePlan, Prisma, ProductGroup } from "@prisma/client";
import prisma from "../db.server";
import type { Db } from "../lib/db-lock.server";
import { castBoolean, nonBlankLines } from "../lib/inflections";
import { planTerms, type PlanTermsOptions } from "../services/care/plan-terms.server";
import { validateProductGroupBelongsToShop } from "./product-grouped.server";
import {
  assertValid,
  attributesOf,
  d,
  type DecimalInput,
  Errors,
  jsonObject,
  validateNumber,
  validatePresence,
} from "./validation.server";

export const STANDARD_EXCLUSIONS = [
  "Theft or loss",
  "Accidental damage",
  "Deliberate damage or misuse",
  "Cash payouts: claims are honoured by repair or replacement only",
] as const;

/** The brand on storefront cover badges ("ShopCare – 2 year plan"). */
export const BADGE_BRAND = "ShopCare";

export type CarePlanWithGroup = CarePlan & { productGroup: ProductGroup | null };

// A type alias (not an interface) so it is assignable to Prisma JSON input.
export type CarePlanPerks = {
  priority: boolean;
  trade_in_bonus_percent: number;
};

export interface CarePlanInput {
  shopId: number;
  name?: string;
  shopifyProductId?: string | null;
  shopifyVariantId?: string;
  price?: DecimalInput;
  termMonths?: number;
  excess?: DecimalInput;
  exclusions?: string | null;
  perks?: Prisma.JsonValue;
  offerWindowDays?: number;
  position?: number;
  active?: boolean;
  productGroupId?: number | null;
}

const DEFAULTS = {
  price: 0,
  termMonths: 24,
  excess: 0,
  perks: {},
  offerWindowDays: 30,
  position: 0,
  active: true,
};

/** "2 years", "1 year", "18 months"; with `plural: false`, "2 year", "18 month". */
export function termText(months: number, { plural = true } = {}): string {
  const whole = Math.trunc(Number(months) || 0);
  const [count, unit] = whole % 12 === 0 ? [whole / 12, "year"] : [whole, "month"];
  return `${count} ${plural && count !== 1 ? `${unit}s` : unit}`;
}

/** "ShopCare – 2 year plan", "ShopCare – 18 month plan". */
export function badgeLabel(months: number): string {
  return `${BADGE_BRAND} – ${termText(months, { plural: false })} plan`;
}

/** Rails `before_validation :normalise_perks`. */
export function normalizePerks(perks: unknown): CarePlanPerks {
  const raw = jsonObject(perks as Prisma.JsonValue);
  return {
    priority: castBoolean(raw.priority),
    trade_in_bonus_percent: d(raw.trade_in_bonus_percent).toNumber(),
  };
}

export function validateCarePlan(attrs: Omit<CarePlanInput, "perks"> & { perks: CarePlanPerks }): Errors {
  const errors = new Errors();
  validatePresence(errors, "name", attrs.name);
  validatePresence(errors, "shopifyVariantId", attrs.shopifyVariantId);
  validateNumber(errors, "termMonths", attrs.termMonths, {
    onlyInteger: true,
    greaterThan: 0,
    lessThanOrEqualTo: 120,
  });
  validateNumber(errors, "offerWindowDays", attrs.offerWindowDays, {
    onlyInteger: true,
    greaterThanOrEqualTo: 0,
    lessThanOrEqualTo: 365,
  });
  validateNumber(errors, "price", attrs.price, { greaterThanOrEqualTo: 0 });
  validateNumber(errors, "excess", attrs.excess, { greaterThanOrEqualTo: 0 });
  const bonus = attrs.perks.trade_in_bonus_percent;
  if (!(bonus >= 0 && bonus <= 100)) {
    errors.add("perks", "trade in bonus percent must be between 0 and 100");
  }
  return errors;
}

async function save(db: Db, attrs: CarePlanInput, id?: number): Promise<CarePlan> {
  const data = { ...DEFAULTS, ...attrs, perks: normalizePerks(attrs.perks) };
  const errors = validateCarePlan(data);
  if (data.shopifyVariantId) {
    const clash = await db.carePlan.findFirst({
      where: {
        shopId: data.shopId,
        shopifyVariantId: data.shopifyVariantId,
        ...(id ? { NOT: { id } } : {}),
      },
      select: { id: true },
    });
    if (clash) errors.add("shopifyVariantId", "is already linked to another Care plan");
  }
  await validateProductGroupBelongsToShop(errors, db, data.shopId, data.productGroupId);
  assertValid("CarePlan", errors);
  const record = { ...data, shopifyVariantId: data.shopifyVariantId as string, name: data.name as string };
  return id
    ? db.carePlan.update({ where: { id }, data: record })
    : db.carePlan.create({ data: record });
}

export function createCarePlan(input: CarePlanInput, db: Db = prisma): Promise<CarePlan> {
  return save(db, input);
}

export async function updateCarePlan(
  id: number,
  patch: Partial<Omit<CarePlanInput, "shopId">>,
  db: Db = prisma,
): Promise<CarePlan> {
  const current = await db.carePlan.findUniqueOrThrow({ where: { id } });
  const attrs = attributesOf(current);
  return save(db, { ...attrs, ...patch }, id);
}

/** Active plans in display order, with their groups. */
export function activeCarePlans(shopId: number, db: Db = prisma) {
  return db.carePlan.findMany({
    where: { shopId, active: true },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    include: { productGroup: true },
  });
}

export function carePlanPriority(plan: Pick<CarePlan, "perks">): boolean {
  return castBoolean(jsonObject(plan.perks).priority);
}

export function tradeInBonusPercent(plan: Pick<CarePlan, "perks">): Prisma.Decimal {
  return d(jsonObject(plan.perks).trade_in_bonus_percent);
}

export function exclusionList(plan: Pick<CarePlan, "exclusions">): string[] {
  return [...STANDARD_EXCLUSIONS, ...nonBlankLines(plan.exclusions)];
}

/** The customer-facing terms (app/services/care/plan-terms). */
export function carePlanTerms(
  plan: Pick<CarePlan, "termMonths" | "excess" | "exclusions" | "perks">,
  options: PlanTermsOptions = {},
): string[] {
  return planTerms(plan, options);
}

/** Frozen copy stored on each Care cover: the terms the customer bought. */
export function carePlanTermsSnapshot(
  plan: CarePlan,
  { product, shop }: Pick<PlanTermsOptions, "product" | "shop"> = {},
) {
  return {
    name: plan.name,
    term_months: plan.termMonths,
    discount_percent: 100.0,
    excess: d(plan.excess).toNumber(),
    perks: jsonObject(plan.perks) as Prisma.JsonObject,
    exclusions: exclusionList(plan),
    price: d(plan.price).toNumber(),
    terms: carePlanTerms(plan, { product, shop }),
  };
}

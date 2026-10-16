/**
 * Merchant-set warranty rules: how long cover lasts, what it does (free or
 * discounted repair), which faults it covers and which products it applies to
 * (its product group). A shop can have several; the first active policy (by
 * position) whose group matches a product wins. Port of WarrantyPolicy.
 */
import { Prisma, type ProductGroup, type WarrantyPolicy } from "@prisma/client";
import prisma from "../db.server";
import type { Db } from "../lib/db-lock.server";
import { nonBlankLines } from "../lib/inflections";
import { plainNumber } from "../lib/money";
import type { ProductFacts } from "./product-facts";
import { appliesTo, validateProductGroupBelongsToShop } from "./product-grouped.server";
import { statutoryRightsNotice } from "./statutory-rights.server";
import {
  assertValid,
  attributesOf,
  d,
  type DecimalInput,
  Errors,
  validateInclusion,
  validateNumber,
  validatePresence,
} from "./validation.server";

export const WARRANTY_OUTCOMES = ["free", "discount"] as const;
export type WarrantyOutcome = (typeof WARRANTY_OUTCOMES)[number];

export type WarrantyPolicyWithGroup = WarrantyPolicy & { productGroup: ProductGroup | null };

export interface WarrantyPolicyInput {
  shopId: number;
  name?: string;
  months?: number;
  outcome?: string;
  discountPercent?: DecimalInput;
  coveredFaults?: string | null;
  position?: number;
  active?: boolean;
  productGroupId?: number | null;
}

const DEFAULTS = { months: 12, outcome: "free", discountPercent: 100, position: 0, active: true };

function normalize(attrs: WarrantyPolicyInput) {
  const merged = { ...DEFAULTS, ...attrs };
  // Rails before_validation: a free outcome is always 100%.
  if (merged.outcome === "free") merged.discountPercent = 100;
  return merged;
}

export function validateWarrantyPolicy(attrs: WarrantyPolicyInput): Errors {
  const errors = new Errors();
  validatePresence(errors, "name", attrs.name);
  validateNumber(errors, "months", attrs.months, {
    onlyInteger: true,
    greaterThan: 0,
    lessThanOrEqualTo: 240,
  });
  validateNumber(errors, "discountPercent", attrs.discountPercent, {
    greaterThan: 0,
    lessThanOrEqualTo: 100,
  });
  validateInclusion(errors, "outcome", attrs.outcome, WARRANTY_OUTCOMES);
  return errors;
}

async function save(db: Db, attrs: WarrantyPolicyInput, id?: number) {
  const data = normalize(attrs);
  const errors = validateWarrantyPolicy(data);
  await validateProductGroupBelongsToShop(errors, db, data.shopId, data.productGroupId);
  assertValid("WarrantyPolicy", errors);
  const record = { ...data, name: data.name as string };
  return id
    ? db.warrantyPolicy.update({ where: { id }, data: record })
    : db.warrantyPolicy.create({ data: record });
}

export function createWarrantyPolicy(input: WarrantyPolicyInput, db: Db = prisma) {
  return save(db, input);
}

export async function updateWarrantyPolicy(
  id: number,
  patch: Partial<Omit<WarrantyPolicyInput, "shopId">>,
  db: Db = prisma,
) {
  const current = await db.warrantyPolicy.findUniqueOrThrow({ where: { id } });
  const attrs = attributesOf(current);
  return save(db, { ...attrs, ...patch }, id);
}

/** Active policies in priority order, with their groups. */
export function activeWarrantyPolicies(shopId: number, db: Db = prisma) {
  return db.warrantyPolicy.findMany({
    where: { shopId, active: true },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    include: { productGroup: true },
  });
}

/** First matching active policy for a product, or null. */
export async function matchingWarrantyPolicy(
  shopId: number,
  facts: ProductFacts,
  db: Db = prisma,
): Promise<WarrantyPolicyWithGroup | null> {
  const policies = await activeWarrantyPolicies(shopId, db);
  return policies.find((policy) => appliesTo(policy, facts)) ?? null;
}

/** Percentage off a repair while covered: a free outcome is 100%. */
export function effectiveDiscountPercent(
  policy: Pick<WarrantyPolicy, "outcome" | "discountPercent">,
): Prisma.Decimal {
  return policy.outcome === "free" ? new Prisma.Decimal(100) : d(policy.discountPercent);
}

export function coveredFaultList(policy: Pick<WarrantyPolicy, "coveredFaults">): string[] {
  return nonBlankLines(policy.coveredFaults);
}

/** What the customer is told: the cover, the faults, the statutory rights sentence. */
export function customerSummary(policy: WarrantyPolicy): string[] {
  const outcome =
    policy.outcome === "free"
      ? "Free repair"
      : `${plainNumber(effectiveDiscountPercent(policy))}% off repairs`;
  const faults = coveredFaultList(policy);
  return [
    `${outcome} for ${policy.months} months from the date you bought your item.`,
    faults.length ? `Covers: ${faults.join("; ")}.` : null,
    statutoryRightsNotice("warranty"),
  ].filter((line): line is string => line !== null);
}

/** Frozen copy stored on each Cover. */
export function warrantyTermsSnapshot(policy: WarrantyPolicy) {
  return {
    name: policy.name,
    months: policy.months,
    outcome: policy.outcome,
    discount_percent: effectiveDiscountPercent(policy).toNumber(),
    covered_faults: coveredFaultList(policy),
  };
}

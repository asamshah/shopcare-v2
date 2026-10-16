/** Warranty policies admin (Rails WarrantyPoliciesController). */
import { Prisma, type WarrantyPolicy } from "@prisma/client";
import prisma from "../../db.server";
import { plainNumber } from "../../lib/money";
import { customerSummary } from "../../models/warranty-policy.server";
import { d } from "../../models/validation.server";
import { chosenGroupId } from "./catalog-forms.server";
import { bool, field, type Form, has, parse, zDecimal, zInt, zText } from "./form.server";
import { groupOptions } from "./setup.server";

export interface PolicyValues {
  name: string;
  months: string;
  active: boolean;
  outcome: string;
  discountPercent: string;
  coveredFaults: string;
  productGroupId: number | null;
  position: string;
}

export function policyValues(p: Pick<WarrantyPolicy, "name" | "months" | "active" | "outcome" | "discountPercent" | "coveredFaults" | "productGroupId" | "position">): PolicyValues {
  return {
    name: p.name,
    months: String(p.months),
    active: p.active,
    outcome: p.outcome,
    discountPercent: plainNumber(p.discountPercent),
    coveredFaults: p.coveredFaults ?? "",
    productGroupId: p.productGroupId,
    position: String(p.position),
  };
}

/** The form's values over `base` (the saved policy, or the new-policy defaults): absent fields keep theirs. */
export async function readPolicy(shopId: number, form: Form, base: PolicyValues) {
  const pick = (name: string, fallback: string) => (has(form, name) ? field(form, name).trim() : fallback);
  const values: PolicyValues = {
    name: parse(zText(255), pick("name", base.name)),
    months: pick("months", base.months),
    active: has(form, "active") ? bool(form, "active") : base.active,
    outcome: parse(zText(20), pick("outcome", base.outcome)),
    discountPercent: pick("discount_percent", base.discountPercent),
    coveredFaults: parse(zText(5000), pick("covered_faults", base.coveredFaults)),
    productGroupId: has(form, "product_group_id")
      ? await chosenGroupId(shopId, field(form, "product_group_id"))
      : base.productGroupId,
    position: pick("position", base.position),
  };
  const months = parse(zInt, values.months);
  const position = parse(zInt, values.position);
  const discount = parse(zDecimal, values.discountPercent);
  const input = {
    name: values.name,
    months: months ?? undefined,
    active: values.active,
    outcome: values.outcome,
    ...(discount === null ? {} : { discountPercent: discount }),
    coveredFaults: values.coveredFaults || null,
    productGroupId: values.productGroupId,
    ...(position === null ? {} : { position }),
  };
  return { values, input };
}

/** "What customers see", from the form's values (saved or not). */
export function policyPreview(values: PolicyValues): string[] {
  const months = parseInt(values.months, 10);
  return customerSummary({
    outcome: values.outcome,
    discountPercent: new Prisma.Decimal(d(values.discountPercent || 100)),
    months: Number.isNaN(months) ? 0 : months,
    coveredFaults: values.coveredFaults,
  } as WarrantyPolicy);
}

export async function policyFormData(shopId: number, values: PolicyValues) {
  return { values, groups: await groupOptions(shopId), preview: policyPreview(values) };
}

export async function nextPolicyPosition(shopId: number) {
  const last = await prisma.warrantyPolicy.aggregate({ where: { shopId }, _max: { position: true } });
  return (last._max.position ?? -1) + 1;
}

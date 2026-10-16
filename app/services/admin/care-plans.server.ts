/**
 * The Care plan builder (Rails CarePlansController). Merchants create the
 * Care product in Shopify; a plan links to its variant and adds the terms.
 * Price and product come from Shopify, not the form.
 */
import { Prisma, type CarePlan, type Shop } from "@prisma/client";
import prisma from "../../db.server";
import { plainNumber } from "../../lib/money";
import { carePlanTerms, normalizePerks } from "../../models/care-plan.server";
import { tradeInEnabled } from "../../models/shop.server";
import { d, jsonObject } from "../../models/validation.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";
import { fetchRepairVariant } from "../../shopify/repair-products.server";
import { chosenGroupId } from "./catalog-forms.server";
import { bool, field, type Form, has, parse, zDecimal, zInt, zText } from "./form.server";

export interface PlanValues {
  name: string;
  shopifyVariantId: string;
  variantLabel: string | null;
  termMonths: string;
  offerWindowDays: string;
  active: boolean;
  excess: string;
  priority: boolean;
  tradeInBonusPercent: string;
  productGroupId: number | null;
  position: string;
  exclusions: string;
}

export function planValues(plan: Pick<CarePlan, "name" | "shopifyVariantId" | "termMonths" | "offerWindowDays" | "active" | "excess" | "perks" | "productGroupId" | "position" | "exclusions" | "price">, variantLabel: string | null): PlanValues {
  const perks = normalizePerks(plan.perks);
  return {
    name: plan.name,
    shopifyVariantId: plan.shopifyVariantId,
    variantLabel,
    termMonths: String(plan.termMonths),
    offerWindowDays: String(plan.offerWindowDays),
    active: plan.active,
    excess: plainNumber(plan.excess),
    priority: perks.priority,
    tradeInBonusPercent: String(perks.trade_in_bonus_percent),
    productGroupId: plan.productGroupId,
    position: String(plan.position),
    exclusions: plan.exclusions ?? "",
  };
}

/** "Generated from this plan": the terms customers see, from the form's values. */
export function termsPreview(values: PlanValues, shop: Pick<Shop, "settings">): string[] {
  const months = parseInt(values.termMonths, 10);
  return carePlanTerms(
    {
      termMonths: Number.isNaN(months) ? 0 : months,
      excess: new Prisma.Decimal(d(values.excess || 0)),
      exclusions: values.exclusions,
      perks: { priority: values.priority, trade_in_bonus_percent: Number(values.tradeInBonusPercent) || 0 },
    },
    { shop },
  );
}

export interface PlanSave {
  values: PlanValues;
  input: {
    name: string;
    shopifyVariantId: string;
    termMonths?: number;
    offerWindowDays?: number;
    active: boolean;
    excess?: string;
    perks: Prisma.JsonObject;
    productGroupId: number | null;
    position?: number;
    exclusions: string | null;
    shopifyProductId?: string;
    price?: string;
  };
  errors: string[];
}

/**
 * Reads the form over `base` and links the Care product when the variant
 * changed (or the plan has no product yet).
 */
export async function readPlan(
  shop: Shop,
  admin: AdminGraphqlClient,
  form: Form,
  base: PlanValues,
  current: Pick<CarePlan, "shopifyVariantId" | "shopifyProductId" | "perks"> | null,
): Promise<PlanSave> {
  const pick = (name: string, fallback: string) => (has(form, name) ? field(form, name).trim() : fallback);
  const values: PlanValues = {
    name: parse(zText(255), pick("name", base.name)),
    // The resource picker sends a numeric id; a pasted GID works too.
    shopifyVariantId: pick("shopify_variant_id", base.shopifyVariantId).match(/\d+$/)?.[0] ?? "",
    variantLabel: base.variantLabel,
    termMonths: pick("term_months", base.termMonths),
    offerWindowDays: pick("offer_window_days", base.offerWindowDays),
    active: has(form, "active") ? bool(form, "active") : base.active,
    excess: pick("excess", base.excess),
    priority: has(form, "perks[priority]") ? bool(form, "perks[priority]") : base.priority,
    // The trade-in perk's field is hidden while trade-in is parked: keep its stored value.
    tradeInBonusPercent:
      tradeInEnabled(shop) && has(form, "perks[trade_in_bonus_percent]")
        ? field(form, "perks[trade_in_bonus_percent]").trim()
        : base.tradeInBonusPercent,
    productGroupId: has(form, "product_group_id")
      ? await chosenGroupId(shop.id, field(form, "product_group_id"))
      : base.productGroupId,
    position: pick("position", base.position),
    exclusions: parse(zText(5000), pick("exclusions", base.exclusions)),
  };
  const termMonths = parse(zInt, values.termMonths);
  const offerWindowDays = parse(zInt, values.offerWindowDays);
  const position = parse(zInt, values.position);
  const excess = parse(zDecimal, values.excess);
  const bonus = parse(zDecimal, values.tradeInBonusPercent);
  const input: PlanSave["input"] = {
    name: values.name,
    shopifyVariantId: values.shopifyVariantId,
    ...(termMonths === null ? {} : { termMonths }),
    ...(offerWindowDays === null ? {} : { offerWindowDays }),
    active: values.active,
    ...(excess === null ? {} : { excess }),
    perks: {
      ...jsonObject(current?.perks ?? {}),
      priority: values.priority,
      trade_in_bonus_percent: bonus === null ? 0 : Number(bonus),
    },
    productGroupId: values.productGroupId,
    ...(position === null ? {} : { position }),
    exclusions: values.exclusions || null,
  };

  const errors: string[] = [];
  const changed = values.shopifyVariantId !== (current?.shopifyVariantId ?? "") || !current?.shopifyProductId;
  if (values.shopifyVariantId && changed) {
    const variant = await fetchRepairVariant(admin, values.shopifyVariantId);
    if (!variant) {
      errors.push("We couldn't find that Care product in Shopify. Choose it again.");
    } else {
      input.shopifyProductId = variant.productId;
      input.price = variant.price;
      values.variantLabel = `${variant.label} · ${variant.price}`;
    }
  }
  return { values, input, errors };
}

export async function nextPlanPosition(shopId: number) {
  const last = await prisma.carePlan.aggregate({ where: { shopId }, _max: { position: true } });
  return (last._max.position ?? -1) + 1;
}

/**
 * Customer-facing terms for a Care plan, generated from its fields: every
 * repair for the plan's term, except the fixed exclusions plus the merchant's
 * own; the excess and priority perk if set; and always the statutory rights
 * sentence. Merchants can add exclusions but can't remove fixed text.
 * Port of Care::PlanTerms.
 */
import type { CarePlan, Shop } from "@prisma/client";
import { formatAmount } from "../../lib/money";
import {
  carePlanPriority,
  exclusionList,
  termText,
} from "../../models/care-plan.server";
import { settingsOf } from "../../models/shop.server";
import { statutoryRightsNotice } from "../../models/statutory-rights.server";
import { d } from "../../models/validation.server";

export interface PlanTermsOptions {
  currency?: string | null;
  product?: string | null;
  /** The plan's shop, for its currency setting when `currency` isn't given. */
  shop?: Pick<Shop, "settings"> | null;
}

/** One sentence per line, in reading order. */
export function planTerms(
  plan: Pick<CarePlan, "termMonths" | "excess" | "exclusions" | "perks">,
  { currency, product, shop }: PlanTermsOptions = {},
): string[] {
  const shopCurrency = shop ? settingsOf(shop).currency : undefined;
  const money =
    currency?.trim() ||
    (typeof shopCurrency === "string" && shopCurrency.trim() ? shopCurrency : "GBP");
  const item = product?.trim() || "item";
  const exclusions = exclusionList(plan)
    .map((text) => text.charAt(0).toLowerCase() + text.slice(1))
    .join("; ");
  const excess = d(plan.excess);
  return [
    `All repairs to your ${item} for ${termText(plan.termMonths)}, except: ${exclusions}.`,
    excess.gt(0) ? `An excess of ${formatAmount(excess, money)} applies to each repair.` : null,
    carePlanPriority(plan) ? "Your repairs get priority turnaround." : null,
    statutoryRightsNotice("plan"),
  ].filter((line): line is string => line !== null);
}

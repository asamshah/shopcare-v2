/**
 * Which products a trade-in program takes (parked for V2): all products, or
 * those with a tag, in a collection, or of a product type. Stored as
 * `eligibility` jsonb: { "mode": "tag", "value": "leather" }. Warranty
 * policies and Care plans use product groups instead (product-grouped).
 * Port of the ProductEligibility concern.
 */
import type { Prisma } from "@prisma/client";
import type { ProductFacts } from "./product-facts";
import { type Errors, jsonObject } from "./validation.server";

export const ELIGIBILITY_MODES = ["all", "tag", "collection", "product_type"] as const;
export type EligibilityMode = (typeof ELIGIBILITY_MODES)[number];

export type Eligibility = {
  mode: string;
  value?: string;
};

export function eligibilityMode(eligibility: Prisma.JsonValue): string {
  const mode = String(jsonObject(eligibility).mode ?? "").trim();
  return mode || "all";
}

export function eligibilityValue(eligibility: Prisma.JsonValue): string {
  const value = jsonObject(eligibility).value;
  return value === null || value === undefined ? "" : String(value);
}

/** Rails `before_validation :normalise_eligibility`. */
export function normalizeEligibility(eligibility: Prisma.JsonValue): Eligibility {
  const mode = eligibilityMode(eligibility);
  let value = eligibilityValue(eligibility).trim();
  if (mode === "collection") value = value.match(/\d+$/)?.[0] ?? ""; // accept a pasted GID
  return mode === "all" ? { mode: "all" } : { mode, value };
}

export function validateEligibility(errors: Errors, eligibility: Prisma.JsonValue): void {
  const mode = eligibilityMode(eligibility);
  if (!(ELIGIBILITY_MODES as readonly string[]).includes(mode)) {
    errors.add("eligibility", "has an unknown product filter");
    return;
  }
  if (mode !== "all" && eligibilityValue(eligibility).trim() === "") {
    errors.add("eligibility", "needs a value for the product filter");
  }
}

export function eligibilityAppliesTo(
  eligibility: Prisma.JsonValue,
  facts: ProductFacts,
): boolean {
  const value = eligibilityValue(eligibility);
  switch (eligibilityMode(eligibility)) {
    case "all":
      return true;
    case "tag":
      return facts.tags.map((t) => t.toLowerCase()).includes(value.toLowerCase());
    case "collection":
      return facts.collectionIds.includes(value);
    case "product_type":
      return (facts.productType ?? "").toLowerCase() === value.toLowerCase();
    default:
      return false;
  }
}

export function eligibilitySummaryText(eligibility: Prisma.JsonValue): string | null {
  const value = eligibilityValue(eligibility);
  switch (eligibilityMode(eligibility)) {
    case "all":
      return "All products";
    case "tag":
      return `Products tagged “${value}”`;
    case "collection":
      return `Collection ${value}`;
    case "product_type":
      return `Product type “${value}”`;
    default:
      return null;
  }
}

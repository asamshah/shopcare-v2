/**
 * One line on a repair quote. Port of QuotationLineItem.
 *   "repair" = the Shopify product the admin selected as the quote
 *   "extra"  = ad-hoc parts/labour added independently on the same quote
 */
import { Prisma, type QuotationLineItem } from "@prisma/client";
import prisma from "../db.server";
import type { Db } from "../lib/db-lock.server";
import {
  assertValid,
  type DecimalInput,
  Errors,
  toDecimal,
  validateInclusion,
  validateNumber,
  validatePresence,
} from "./validation.server";

export const LINE_ITEM_KINDS = ["repair", "extra"] as const;
export type LineItemKind = (typeof LINE_ITEM_KINDS)[number];

export interface QuotationLineItemInput {
  quotationId: number;
  kind?: string;
  title?: string;
  quantity?: number;
  unitPrice?: DecimalInput;
  discount?: DecimalInput;
  shopifyProductId?: string | null;
  shopifyVariantId?: string | null;
}

const DEFAULTS = { kind: "repair", quantity: 1, unitPrice: 0, discount: 0 };

export function validateQuotationLineItem(line: Omit<QuotationLineItemInput, "quotationId">): Errors {
  const attrs = { ...DEFAULTS, ...line };
  const errors = new Errors();
  validateInclusion(errors, "kind", attrs.kind, LINE_ITEM_KINDS);
  validatePresence(errors, "title", attrs.title);
  validateNumber(errors, "quantity", attrs.quantity, { onlyInteger: true, greaterThan: 0 });
  validateNumber(errors, "unitPrice", attrs.unitPrice, { greaterThanOrEqualTo: 0 });
  validateNumber(errors, "discount", attrs.discount, { greaterThanOrEqualTo: 0 });
  const unitPrice = toDecimal(attrs.unitPrice);
  const discount = toDecimal(attrs.discount);
  const quantity = toDecimal(attrs.quantity);
  if (unitPrice && discount && quantity && discount.gt(unitPrice.mul(quantity))) {
    errors.add("discount", "can't be more than the line total");
  }
  return errors;
}

export async function createQuotationLineItem(
  input: QuotationLineItemInput,
  db: Db = prisma,
): Promise<QuotationLineItem> {
  const data = { ...DEFAULTS, ...input };
  assertValid("QuotationLineItem", validateQuotationLineItem(data));
  return db.quotationLineItem.create({ data: { ...data, title: data.title as string } });
}

export async function updateQuotationLineItem(
  id: number,
  patch: Partial<Omit<QuotationLineItemInput, "quotationId">>,
  db: Db = prisma,
): Promise<QuotationLineItem> {
  const current = await db.quotationLineItem.findUniqueOrThrow({ where: { id } });
  assertValid("QuotationLineItem", validateQuotationLineItem({ ...current, ...patch }));
  return db.quotationLineItem.update({ where: { id }, data: patch });
}

/** qty × unit price − discount. */
export function lineTotal(
  line: Pick<QuotationLineItem, "unitPrice" | "quantity" | "discount">,
): Prisma.Decimal {
  return new Prisma.Decimal(line.unitPrice).mul(line.quantity).sub(line.discount);
}

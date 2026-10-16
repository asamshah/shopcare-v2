/**
 * The Shopify draft order behind a quotation (Rails Repairs::QuoteDraftOrder).
 *
 * Ported so far: `quoteDraftOrderAttributes`, the draft order's content.
 * TODO(wave 2, money services): `id!` (create, or update a draft left by a
 * failed attempt) and `delete`, calling createDraftOrder / updateDraftOrder /
 * deleteDraftOrder from app/shopify/draft-orders.server.ts under the
 * quotation's row lock.
 *
 * Every line is priced from the quote. A "repair" line backed by a real
 * Shopify variant links to the product and carries the quote's unit price as
 * `priceOverride` (Rails sent `price`, which REST ignored on variant lines, so
 * the invoice could differ from the quote). Other lines are custom-titled. A
 * line's own discount and its share of the cover discount go to Shopify as
 * one fixed discount; a Care plan's excess is one extra line.
 */
import { Prisma, type QuotationLineItem } from "@prisma/client";
import type {
  DraftOrderAttributes,
  DraftOrderLine,
} from "../../shopify/draft-orders.server";

type Line = Pick<
  QuotationLineItem,
  | "title"
  | "quantity"
  | "unitPrice"
  | "discount"
  | "coverDiscount"
  | "shopifyVariantId"
>;

export interface QuoteDraftOrderInput {
  quotation: {
    id: number;
    currency: string | null;
    coverExcess: Prisma.Decimal | number | string;
  };
  lineItems: Line[];
  ticket: { id: number; customerEmail: string | null };
  /** The cover applied to the quote (named on discounts and the excess). */
  coverName?: string | null;
  /** Shop.repairOrderTag(). */
  orderTag: string;
  /** The shop's currency, when the quote has none recorded. */
  shopCurrency: string;
}

const money = (amount: Prisma.Decimal | number | string) =>
  new Prisma.Decimal(amount).toFixed(2);

function discountDescription(line: Line, coverName: string | null | undefined) {
  if (!new Prisma.Decimal(line.coverDiscount).gt(0)) return "Discount";
  const name = coverName ?? "Cover";
  return new Prisma.Decimal(line.discount).gt(0) ? `Discount + ${name}` : name;
}

export function quoteDraftOrderLine(
  line: Line,
  coverName?: string | null,
): DraftOrderLine {
  const discount = new Prisma.Decimal(line.discount).add(line.coverDiscount);
  const appliedDiscount = discount.gt(0)
    ? {
        description: discountDescription(line, coverName),
        valueType: "FIXED_AMOUNT" as const,
        value: money(discount),
      }
    : undefined;
  const variantId = line.shopifyVariantId?.trim();
  return variantId
    ? {
        variantId,
        quantity: line.quantity,
        priceOverride: money(line.unitPrice),
        ...(appliedDiscount ? { appliedDiscount } : {}),
      }
    : {
        title: line.title,
        quantity: line.quantity,
        price: money(line.unitPrice),
        requiresShipping: false,
        taxable: true,
        ...(appliedDiscount ? { appliedDiscount } : {}),
      };
}

export function quoteDraftOrderAttributes(
  input: QuoteDraftOrderInput,
): DraftOrderAttributes {
  const { quotation, ticket, coverName } = input;
  const lines = input.lineItems.map((line) =>
    quoteDraftOrderLine(line, coverName),
  );
  if (new Prisma.Decimal(quotation.coverExcess).gt(0)) {
    lines.push({
      title: `${coverName ?? "Cover"}: excess`,
      quantity: 1,
      price: money(quotation.coverExcess),
      requiresShipping: false,
      taxable: true,
    });
  }
  return {
    lineItems: lines,
    currencyCode: quotation.currency || input.shopCurrency,
    email: ticket.customerEmail,
    tags: input.orderTag,
    note: `Repair ticket #${ticket.id}`,
    customAttributes: [
      { key: "repair_quotation_id", value: String(quotation.id) },
      { key: "repair_ticket_id", value: String(ticket.id) },
    ],
    useCustomerDefaultAddress: false,
  };
}

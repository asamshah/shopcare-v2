/**
 * The quote → draft order content (Rails Repairs::QuoteDraftOrder#attributes),
 * with the v2 fix: real repair variants are charged the quote's price.
 */
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  quoteDraftOrderAttributes,
  quoteDraftOrderLine,
} from "../../../app/services/repairs/quote-draft-order.server";
import { draftOrderInput } from "../../../app/shopify/draft-orders.server";

const line = (overrides: Record<string, unknown> = {}) => ({
  title: "Resole",
  quantity: 1,
  unitPrice: new Prisma.Decimal("45.00"),
  discount: new Prisma.Decimal(0),
  coverDiscount: new Prisma.Decimal(0),
  shopifyVariantId: null as string | null,
  ...overrides,
});

describe("quote draft order lines", () => {
  it("charges a real repair variant the quote's price via priceOverride", () => {
    const priced = quoteDraftOrderLine(line({ shopifyVariantId: "4001", unitPrice: new Prisma.Decimal("38.50") }));
    expect(priced).toEqual({ variantId: "4001", quantity: 1, priceOverride: "38.50" });

    // …and that reaches Shopify as the line's priceOverride, in the quote currency.
    const input = draftOrderInput({ currencyCode: "GBP", lineItems: [priced] });
    expect((input.lineItems as Record<string, unknown>[])[0]).toEqual({
      variantId: "gid://shopify/ProductVariant/4001",
      quantity: 1,
      priceOverride: { amount: "38.50", currencyCode: "GBP" },
    });
  });

  it("sends other lines as custom lines, with one fixed discount for line + cover discount", () => {
    expect(
      quoteDraftOrderLine(
        line({ discount: new Prisma.Decimal(5), coverDiscount: new Prisma.Decimal("10.5") }),
        "2-year Care",
      ),
    ).toEqual({
      title: "Resole",
      quantity: 1,
      price: "45.00",
      requiresShipping: false,
      taxable: true,
      appliedDiscount: { description: "Discount + 2-year Care", valueType: "FIXED_AMOUNT", value: "15.50" },
    });
    expect(quoteDraftOrderLine(line({ discount: new Prisma.Decimal(5) })).appliedDiscount?.description).toBe(
      "Discount",
    );
  });
});

describe("quoteDraftOrderAttributes", () => {
  it("builds the whole draft order, adding the cover excess as a line", () => {
    const attrs = quoteDraftOrderAttributes({
      quotation: { id: 3, currency: "EUR", coverExcess: "10" },
      lineItems: [line({ shopifyVariantId: "4001" }), line({ title: "Laces", unitPrice: new Prisma.Decimal(4) })],
      ticket: { id: 12, customerEmail: "a@example.com" },
      coverName: "2-year Care",
      orderTag: "repair",
      shopCurrency: "GBP",
    });
    expect(attrs).toEqual({
      currencyCode: "EUR",
      email: "a@example.com",
      tags: "repair",
      note: "Repair ticket #12",
      customAttributes: [
        { key: "repair_quotation_id", value: "3" },
        { key: "repair_ticket_id", value: "12" },
      ],
      useCustomerDefaultAddress: false,
      lineItems: [
        { variantId: "4001", quantity: 1, priceOverride: "45.00" },
        { title: "Laces", quantity: 1, price: "4.00", requiresShipping: false, taxable: true },
        { title: "2-year Care: excess", quantity: 1, price: "10.00", requiresShipping: false, taxable: true },
      ],
    });
  });

  it("falls back to the shop currency when the quote has none", () => {
    const attrs = quoteDraftOrderAttributes({
      quotation: { id: 3, currency: null, coverExcess: 0 },
      lineItems: [],
      ticket: { id: 12, customerEmail: null },
      orderTag: "repair",
      shopCurrency: "GBP",
    });
    expect(attrs.currencyCode).toBe("GBP");
    expect(attrs.lineItems).toEqual([]);
  });
});

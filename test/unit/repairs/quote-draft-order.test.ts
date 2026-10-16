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
import {
  orderConfirmationAttributes,
  REPAIR_ORDER_TAG,
} from "../../../app/services/repairs/order-confirmation.server";
import { verifyPostageSlipLink } from "../../../app/services/repairs/postage-slip.server";

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
      tags: ["repair", "shopcare-repair"],
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

describe("order confirmation attributes (read by the Order confirmation snippet)", () => {
  const workshop = {
    workshop_address: {
      name: "Acme Repairs",
      line1: "4 Cobbler's Yard",
      line2: "",
      city: "Northampton",
      postcode: "NN1 1AA",
      country: "United Kingdom",
    },
    posting_instructions: "Use a tracked service.",
    quote_valid_days: "14",
    notifications: { status_url: "https://acme.example/pages/repairs" },
  };
  const shop = { shopifyDomain: "acme.myshopify.com", settings: workshop };
  const now = new Date(Date.UTC(2026, 9, 16, 10));

  it("carries a signed slip link (quote validity + 30 days), the workshop address and instructions", () => {
    const attrs = orderConfirmationAttributes(shop, { id: 42, itemReceivedAt: null }, now);
    const byKey = Object.fromEntries(attrs.map((a) => [a.key, a.value]));
    expect(Object.keys(byKey)).toEqual([
      "shopcare_status_url",
      "shopcare_postage_slip_url",
      "shopcare_workshop_address",
      "shopcare_posting_instructions",
    ]);
    expect(byKey.shopcare_status_url).toBe("https://acme.example/pages/repairs");
    expect(byKey.shopcare_workshop_address).toBe(
      "Acme Repairs\n4 Cobbler's Yard\nNorthampton NN1 1AA\nUnited Kingdom",
    );
    expect(byKey.shopcare_posting_instructions).toBe("Use a tracked service.");
    const url = new URL(byKey.shopcare_postage_slip_url);
    expect(url.origin + url.pathname).toBe("https://acme.myshopify.com/apps/repairs/tickets/42/postage-slip");
    expect(verifyPostageSlipLink("acme.myshopify.com", 42, url.searchParams, now)).toBe("valid");
    const day44 = new Date(now.getTime() + 43 * 86_400_000);
    const day45 = new Date(now.getTime() + 45 * 86_400_000);
    expect(verifyPostageSlipLink("acme.myshopify.com", 42, url.searchParams, day44)).toBe("valid");
    expect(verifyPostageSlipLink("acme.myshopify.com", 42, url.searchParams, day45)).toBe("expired");
  });

  it("says the item is already here instead of posting details", () => {
    expect(orderConfirmationAttributes(shop, { id: 42, itemReceivedAt: now }, now)).toEqual([
      { key: "shopcare_status_url", value: "https://acme.example/pages/repairs" },
      { key: "shopcare_item_received", value: "yes" },
    ]);
  });

  it("has no slip link without a complete workshop address", () => {
    expect(
      orderConfirmationAttributes({ shopifyDomain: "acme.myshopify.com", settings: {} }, { id: 42, itemReceivedAt: null }, now),
    ).toEqual([]);
  });

  it("go onto the draft order after the quotation and ticket ids, and the order is tagged", () => {
    const attrs = quoteDraftOrderAttributes({
      quotation: { id: 3, currency: "GBP", coverExcess: 0 },
      lineItems: [],
      ticket: { id: 42, customerEmail: null },
      orderTag: "shopcare-repair",
      shopCurrency: "GBP",
      confirmationAttributes: [{ key: "shopcare_item_received", value: "yes" }],
    });
    expect(attrs.tags).toEqual([REPAIR_ORDER_TAG]);
    expect(attrs.customAttributes).toEqual([
      { key: "repair_quotation_id", value: "3" },
      { key: "repair_ticket_id", value: "42" },
      { key: "shopcare_item_received", value: "yes" },
    ]);
  });
});

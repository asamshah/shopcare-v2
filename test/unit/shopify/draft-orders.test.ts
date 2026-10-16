/**
 * Ported from Rails test/services/shopify/admin_api_test.rb. The REST calls
 * it checked are GraphQL mutations now, so the same scenarios assert on the
 * operation and variables sent.
 */
import { describe, expect, it } from "vitest";
import {
  completeDraftOrder,
  createDraftOrder,
  deleteDraftOrder,
  sendDraftOrderInvoice,
  updateDraftOrder,
  type DraftOrderAttributes,
} from "../../../app/shopify/draft-orders.server";
import { updateRepairStatus } from "../../../app/shopify/customers.server";
import { FakeGraphql } from "../../support/fake-graphql";

const draft = (id = 7) => ({
  id: `gid://shopify/DraftOrder/${id}`,
  name: `#D${id}`,
  invoiceUrl: "https://shop.test/invoices/abc",
  status: "OPEN",
});

const quote: DraftOrderAttributes = {
  currencyCode: "GBP",
  email: "a@b.com",
  tags: "repair",
  note: "Repair ticket #12",
  customAttributes: [
    { key: "repair_quotation_id", value: "3" },
    { key: "repair_ticket_id", value: "12" },
  ],
  useCustomerDefaultAddress: false,
  lineItems: [
    {
      variantId: "100",
      quantity: 1,
      appliedDiscount: {
        description: "Care plan",
        valueType: "FIXED_AMOUNT",
        value: 5,
      },
    },
    {
      title: "Resole",
      quantity: 1,
      price: 30,
      requiresShipping: false,
      taxable: true,
    },
  ],
};

describe("draft orders", () => {
  it("createDraftOrder sends the quote as DraftOrderInput and returns the numeric id and invoice URL", async () => {
    const api = new FakeGraphql({
      draftOrderCreate: {
        draftOrderCreate: { draftOrder: draft(7), userErrors: [] },
      },
    });

    const created = await createDraftOrder(api, quote);

    expect(created).toMatchObject({
      id: "7",
      gid: "gid://shopify/DraftOrder/7",
      invoiceUrl: "https://shop.test/invoices/abc",
    });
    const input = api.calls[0].variables.input as Record<string, unknown>;
    expect(input).toMatchObject({
      email: "a@b.com",
      tags: ["repair"],
      note: "Repair ticket #12",
      customAttributes: quote.customAttributes,
      useCustomerDefaultAddress: false,
      presentmentCurrencyCode: "GBP",
    });
    expect(input.lineItems).toEqual([
      {
        variantId: "gid://shopify/ProductVariant/100",
        quantity: 1,
        appliedDiscount: {
          description: "Care plan",
          valueType: "FIXED_AMOUNT",
          value: 5,
          amountWithCurrency: { amount: "5.00", currencyCode: "GBP" },
        },
      },
      {
        title: "Resole",
        quantity: 1,
        originalUnitPriceWithCurrency: { amount: "30.00", currencyCode: "GBP" },
        requiresShipping: false,
        taxable: true,
      },
    ]);
  });

  it("updateDraftOrder replaces the details of the draft by GID", async () => {
    const api = new FakeGraphql({
      draftOrderUpdate: {
        draftOrderUpdate: { draftOrder: draft(9), userErrors: [] },
      },
    });

    const updated = await updateDraftOrder(api, "9", {
      currencyCode: "GBP",
      lineItems: [{ title: "Resole", quantity: 1, price: "30.00" }],
    });

    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].variables.id).toBe("gid://shopify/DraftOrder/9");
    expect(
      (api.calls[0].variables.input as { lineItems: unknown[] }).lineItems,
    ).toEqual([
      {
        title: "Resole",
        quantity: 1,
        originalUnitPriceWithCurrency: { amount: "30.00", currencyCode: "GBP" },
      },
    ]);
    expect(updated.id).toBe("9");
  });

  it("completeDraftOrder marks it paid (no payment gateway) and returns the order", async () => {
    const api = new FakeGraphql({
      draftOrderComplete: {
        draftOrderComplete: {
          draftOrder: {
            ...draft(9),
            status: "COMPLETED",
            order: { id: "gid://shopify/Order/55", name: "#1055" },
          },
          userErrors: [],
        },
      },
    });

    const completed = await completeDraftOrder(api, "9");

    expect(api.calls[0].variables).toEqual({
      id: "gid://shopify/DraftOrder/9",
    });
    expect(api.calls[0].query).not.toContain("paymentGatewayId");
    expect(completed).toMatchObject({
      id: "9",
      orderId: "55",
      orderName: "#1055",
    });
  });

  it("sendDraftOrderInvoice sends the subject and message", async () => {
    const api = new FakeGraphql({
      draftOrderInvoiceSend: {
        draftOrderInvoiceSend: { draftOrder: draft(9), userErrors: [] },
      },
    });

    await sendDraftOrderInvoice(api, "9", { subject: "S", customMessage: "M" });

    expect(api.calls[0].variables).toEqual({
      id: "gid://shopify/DraftOrder/9",
      email: { subject: "S", customMessage: "M" },
    });
  });

  it("deleteDraftOrder deletes by GID and returns the numeric id", async () => {
    const api = new FakeGraphql({
      draftOrderDelete: {
        draftOrderDelete: {
          deletedId: "gid://shopify/DraftOrder/9",
          userErrors: [],
        },
      },
    });

    expect(await deleteDraftOrder(api, "9")).toBe("9");
    expect(api.calls[0].variables).toEqual({
      input: { id: "gid://shopify/DraftOrder/9" },
    });
  });

  it("raises a mutation's userErrors", async () => {
    const api = new FakeGraphql({
      draftOrderCreate: {
        draftOrderCreate: {
          draftOrder: null,
          userErrors: [{ field: ["email"], message: "Email is invalid" }],
        },
      },
    });

    await expect(createDraftOrder(api, quote)).rejects.toMatchObject({
      name: "ShopifyUserError",
      message: "Email is invalid",
    });
  });
});

describe("updateRepairStatus", () => {
  it("reads, merges and writes the json metafield", async () => {
    const api = new FakeGraphql({
      "metafield(namespace:": {
        customer: {
          id: "gid://shopify/Customer/5",
          metafield: { value: '{"10_20":"requested","11_21":"requested"}' },
        },
      },
      metafieldsSet: { metafieldsSet: { metafields: [], userErrors: [] } },
    });

    await updateRepairStatus(api, "5", "10_20", "paid");

    expect(api.calls[0].variables).toEqual({
      id: "gid://shopify/Customer/5",
      namespace: "repairs",
      key: "requested_products",
    });
    const [written] = api.calls[1].variables.metafields as {
      ownerId: string;
      type: string;
      value: string;
    }[];
    expect(written.ownerId).toBe("gid://shopify/Customer/5");
    expect(written.type).toBe("json");
    expect(JSON.parse(written.value)).toEqual({
      "10_20": "paid",
      "11_21": "requested",
    });
  });

  it("starts from {} when the metafield is missing or not JSON", async () => {
    const api = new FakeGraphql({
      "metafield(namespace:": {
        customer: { id: "x", metafield: { value: "not json" } },
      },
      metafieldsSet: { metafieldsSet: { metafields: [], userErrors: [] } },
    });

    expect(await updateRepairStatus(api, "5", "10_20", "paid")).toEqual({
      "10_20": "paid",
    });
  });
});

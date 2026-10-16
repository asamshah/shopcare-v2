/**
 * Shopify calls behind trade-in credit (Rails test/services/trade_ins/
 * trade_ins_test.rb: store credit and discount-code scenarios), Care refunds,
 * Flow triggers, shop info and marketing consent.
 */
import { describe, expect, it } from "vitest";
import { fetchEmailMarketingConsent } from "../../../app/shopify/customers.server";
import {
  createDiscountCode,
  generateDiscountCode,
} from "../../../app/shopify/discount-codes.server";
import { triggerFlow } from "../../../app/shopify/flow.server";
import { refundLineItem } from "../../../app/shopify/refunds.server";
import {
  fetchShopInfo,
  fetchShopName,
  storeNameFromDomain,
} from "../../../app/shopify/shop.server";
import { creditStoreCredit } from "../../../app/shopify/store-credit.server";
import { FakeGraphql } from "../../support/fake-graphql";

describe("store credit", () => {
  it("credits the customer's account and returns the transaction", async () => {
    const api = new FakeGraphql({
      storeCreditAccountCredit: {
        storeCreditAccountCredit: {
          storeCreditAccountTransaction: {
            id: "gid://shopify/StoreCreditAccountCreditTransaction/1",
          },
          userErrors: [],
        },
      },
    });
    const expiresAt = new Date("2027-01-01T00:00:00Z");

    const id = await creditStoreCredit(api, {
      customerId: "77",
      amount: 25,
      currencyCode: "GBP",
      expiresAt,
    });

    expect(id).toBe("gid://shopify/StoreCreditAccountCreditTransaction/1");
    expect(api.calls[0].variables).toEqual({
      id: "gid://shopify/Customer/77",
      input: {
        creditAmount: { amount: "25.00", currencyCode: "GBP" },
        notify: true,
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
    });
  });

  it("raises userErrors", async () => {
    const api = new FakeGraphql({
      storeCreditAccountCredit: {
        storeCreditAccountCredit: {
          storeCreditAccountTransaction: null,
          userErrors: [{ field: ["id"], message: "Customer not found" }],
        },
      },
    });
    await expect(
      creditStoreCredit(api, {
        customerId: "1",
        amount: 5,
        currencyCode: "GBP",
      }),
    ).rejects.toThrow("Customer not found");
  });
});

describe("discount codes", () => {
  const created = {
    discountCodeBasicCreate: {
      codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/1" },
      userErrors: [],
    },
  };

  it("guests get a single-use code for the amount, for everyone and everything", async () => {
    const api = new FakeGraphql({ discountCodeBasicCreate: created });
    const code = generateDiscountCode("TRADEIN");

    const id = await createDiscountCode(api, {
      title: "ShopCare trade-in credit: Aria Boot",
      code,
      amount: 12.5,
    });

    expect(code).toMatch(/^TRADEIN-[A-Z0-9]{8}$/);
    expect(id).toBe("gid://shopify/DiscountCodeNode/1");
    const input = api.calls[0].variables.input as Record<string, unknown>;
    expect(input).toMatchObject({
      code,
      usageLimit: 1,
      appliesOncePerCustomer: true,
      context: { all: "ALL" },
      customerGets: {
        value: {
          discountAmount: { amount: "12.50", appliesOnEachItem: false },
        },
        items: { all: true },
      },
      combinesWith: {
        productDiscounts: false,
        orderDiscounts: false,
        shippingDiscounts: true,
      },
    });
    expect(input).not.toHaveProperty("endsAt");
  });

  it("a known customer and products restrict the code", async () => {
    const api = new FakeGraphql({ discountCodeBasicCreate: created });

    await createDiscountCode(api, {
      title: "Care credit",
      code: "CARE-1",
      amount: "10",
      customerId: "77",
      productIds: ["10", "11"],
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    });

    expect(api.calls[0].variables.input).toMatchObject({
      endsAt: "2027-01-01T00:00:00.000Z",
      context: { customers: { add: ["gid://shopify/Customer/77"] } },
      customerGets: {
        items: {
          products: {
            productsToAdd: [
              "gid://shopify/Product/10",
              "gid://shopify/Product/11",
            ],
          },
        },
      },
    });
  });

  it("raises userErrors", async () => {
    const api = new FakeGraphql({
      discountCodeBasicCreate: {
        discountCodeBasicCreate: {
          codeDiscountNode: null,
          userErrors: [{ field: ["code"], message: "Code must be unique" }],
        },
      },
    });
    await expect(
      createDiscountCode(api, { title: "t", code: "X", amount: 1 }),
    ).rejects.toThrow("Code must be unique");
  });
});

describe("refundLineItem", () => {
  it("refunds in the presentment currency when the customer paid in another currency", async () => {
    const api = new FakeGraphql({
      suggestedRefund: {
        order: {
          currencyCode: "GBP",
          presentmentCurrencyCode: "EUR",
          suggestedRefund: {
            suggestedTransactions: [
              {
                gateway: "shopify_payments",
                amountSet: {
                  shopMoney: { amount: "15.00", currencyCode: "GBP" },
                  presentmentMoney: { amount: "17.40", currencyCode: "EUR" },
                },
                parentTransaction: { id: "gid://shopify/OrderTransaction/3" },
              },
            ],
          },
        },
      },
      refundCreate: {
        refundCreate: { refund: { id: "gid://shopify/Refund/8" }, userErrors: [] },
      },
    });

    await refundLineItem(api, { orderId: "9", lineItemId: "55", note: "n" });

    const input = api.calls[1].variables.input as Record<string, unknown>;
    expect(input.currency).toBe("EUR");
    expect(input.transactions).toEqual([
      expect.objectContaining({ amount: "17.40", kind: "REFUND" }),
    ]);
  });

  it("uses shop money (and no currency) when the order is in the shop's currency", async () => {
    const api = new FakeGraphql({
      suggestedRefund: {
        order: {
          currencyCode: "GBP",
          presentmentCurrencyCode: "GBP",
          suggestedRefund: {
            suggestedTransactions: [
              {
                gateway: "shopify_payments",
                amountSet: {
                  shopMoney: { amount: "15.00", currencyCode: "GBP" },
                  presentmentMoney: { amount: "15.00", currencyCode: "GBP" },
                },
                parentTransaction: null,
              },
            ],
          },
        },
      },
      refundCreate: {
        refundCreate: { refund: { id: "gid://shopify/Refund/8" }, userErrors: [] },
      },
    });
    await refundLineItem(api, { orderId: "9", lineItemId: "55", note: "n" });
    const input = api.calls[1].variables.input as Record<string, unknown>;
    expect(input).not.toHaveProperty("currency");
    expect(input.transactions).toEqual([expect.objectContaining({ amount: "15.00" })]);
  });

  it("refunds the line to the original payment from the suggested transactions", async () => {
    const api = new FakeGraphql({
      suggestedRefund: {
        order: {
          suggestedRefund: {
            suggestedTransactions: [
              {
                gateway: "shopify_payments",
                amountSet: { shopMoney: { amount: "15.00" } },
                parentTransaction: { id: "gid://shopify/OrderTransaction/3" },
              },
            ],
          },
        },
      },
      refundCreate: {
        refundCreate: {
          refund: { id: "gid://shopify/Refund/8" },
          userErrors: [],
        },
      },
    });

    const id = await refundLineItem(api, {
      orderId: "9",
      lineItemId: "55",
      note: "ShopCare: Care plan refunded with its item",
    });

    expect(id).toBe("gid://shopify/Refund/8");
    const lines = [
      {
        lineItemId: "gid://shopify/LineItem/55",
        quantity: 1,
        restockType: "NO_RESTOCK",
      },
    ];
    expect(api.calls[0].variables).toEqual({
      id: "gid://shopify/Order/9",
      lines,
    });
    expect(api.calls[1].variables.input).toEqual({
      orderId: "gid://shopify/Order/9",
      notify: true,
      note: "ShopCare: Care plan refunded with its item",
      refundLineItems: lines,
      transactions: [
        {
          orderId: "gid://shopify/Order/9",
          parentId: "gid://shopify/OrderTransaction/3",
          gateway: "shopify_payments",
          amount: "15.00",
          kind: "REFUND",
        },
      ],
    });
  });
});

describe("triggerFlow", () => {
  it("sends the customer id as a number with the fields, and raises userErrors", async () => {
    const api = new FakeGraphql({
      flowTriggerReceive: { flowTriggerReceive: { userErrors: [] } },
    });
    await triggerFlow(api, "shopcare-quote-paid", {
      customerId: "77",
      fields: { ticket_id: 1 },
    });
    expect(api.calls[0].variables).toEqual({
      handle: "shopcare-quote-paid",
      payload: { customer_id: 77, ticket_id: 1 },
    });

    await triggerFlow(api, "staff", { fields: { a: 1 } });
    expect(api.calls[1].variables.payload).toEqual({ a: 1 });

    const failing = new FakeGraphql({
      flowTriggerReceive: {
        flowTriggerReceive: {
          userErrors: [{ field: null, message: "Unknown handle" }],
        },
      },
    });
    await expect(triggerFlow(failing, "x", { fields: {} })).rejects.toThrow(
      "Unknown handle",
    );
  });
});

describe("shop info", () => {
  const api = new FakeGraphql({
    "shop {": {
      shop: {
        name: " Acme Boots ",
        email: "owner@acme.test",
        contactEmail: "hello@acme.test",
        currencyCode: "GBP",
        myshopifyDomain: "acme-boots.myshopify.com",
      },
    },
  });

  it("reads name, emails and currency", async () => {
    expect(await fetchShopInfo(api)).toMatchObject({
      contactEmail: "hello@acme.test",
      currencyCode: "GBP",
    });
    expect(await fetchShopName(api)).toBe("Acme Boots");
  });

  it("falls back to a name from the domain", () => {
    expect(storeNameFromDomain("acme-boots.myshopify.com")).toBe("Acme Boots");
  });
});

describe("fetchEmailMarketingConsent", () => {
  const consent = (marketingState: string | null) =>
    new FakeGraphql({
      "customer(id:": {
        customer: {
          id: "gid://shopify/Customer/5",
          defaultEmailAddress: marketingState
            ? {
                emailAddress: "s@example.com",
                marketingState,
                marketingUpdatedAt: "2026-01-01T00:00:00Z",
              }
            : null,
        },
      },
    });

  it("only SUBSCRIBED may be sent marketing", async () => {
    const subscribed = await fetchEmailMarketingConsent(
      consent("SUBSCRIBED"),
      "5",
    );
    expect(subscribed).toEqual({
      email: "s@example.com",
      state: "SUBSCRIBED",
      updatedAt: "2026-01-01T00:00:00Z",
      subscribed: true,
    });
    for (const state of [
      "NOT_SUBSCRIBED",
      "PENDING",
      "UNSUBSCRIBED",
      "INVALID",
    ]) {
      expect(
        (await fetchEmailMarketingConsent(consent(state), "5"))?.subscribed,
      ).toBe(false);
    }
    expect(await fetchEmailMarketingConsent(consent(null), "5")).toMatchObject({
      email: null,
      subscribed: false,
    });
  });

  it("is null for an unknown customer", async () => {
    const api = new FakeGraphql({ "customer(id:": { customer: null } });
    expect(await fetchEmailMarketingConsent(api, "5")).toBeNull();
    expect(api.calls[0].variables.id).toBe("gid://shopify/Customer/5");
  });
});

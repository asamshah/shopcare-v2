/** The credit half of Rails test/services/trade_ins/trade_ins_test.rb (CreditIssuer). */
import { describe, expect, it } from "vitest";
import { issueTradeInCredit } from "../../../../app/services/trade_ins/credit-issuer.server";
import { createShop, createTradeInFor } from "../../../support/factories";
import { FakeGraphql } from "../../../support/fake-graphql";

const now = new Date("2026-10-16T12:00:00Z");
const fakeApi = () =>
  new FakeGraphql({
    storeCreditAccountCredit: {
      storeCreditAccountCredit: {
        storeCreditAccountTransaction: { id: "gid://shopify/StoreCreditAccountCreditTransaction/1" },
        userErrors: [],
      },
    },
    discountCodeBasicCreate: {
      discountCodeBasicCreate: { codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/1" }, userErrors: [] },
    },
  });

describe("issueTradeInCredit", () => {
  it("credits a known customer's store credit in the trade-in currency, expiring per settings", async () => {
    const shop = await createShop({ settings: { trade_in: { credit_method: "store_credit", credit_days: "30" } } });
    const tradeIn = await createTradeInFor(shop, { shopifyCustomerId: "77", quotedCredit: 25, finalCredit: 12.5, currency: "EUR" });
    const api = fakeApi();

    const result = await issueTradeInCredit(shop, api, tradeIn, { shopCurrency: "GBP", now });

    expect(result).toEqual({ method: "store_credit", reference: "gid://shopify/StoreCreditAccountCreditTransaction/1" });
    expect(api.calls[0].variables).toMatchObject({
      id: "gid://shopify/Customer/77",
      input: {
        creditAmount: { amount: "12.50", currencyCode: "EUR" },
        expiresAt: "2026-11-15T12:00:00.000Z",
      },
    });
  });

  it("gives guests (and shops choosing codes) a single-use discount code", async () => {
    const shop = await createShop();
    const guest = await createTradeInFor(shop, { quotedCredit: 25 });
    const api = fakeApi();

    const result = await issueTradeInCredit(shop, api, guest, { shopCurrency: "GBP", now });

    expect(result.method).toBe("discount_code");
    expect(result.reference).toMatch(/^TRADEIN-/);
    expect(api.calls[0].query).toContain("discountCodeBasicCreate");

    const codes = await createShop({ settings: { trade_in: { credit_method: "discount_code" } } });
    const known = await createTradeInFor(codes, { shopifyCustomerId: "77", quotedCredit: 25 });
    expect((await issueTradeInCredit(codes, fakeApi(), known, { shopCurrency: "GBP", now })).method).toBe(
      "discount_code",
    );
  });

  it("refuses to credit nothing", async () => {
    const shop = await createShop();
    const tradeIn = await createTradeInFor(shop, { quotedCredit: 0 });
    await expect(issueTradeInCredit(shop, fakeApi(), tradeIn, { shopCurrency: "GBP", now })).rejects.toThrow(
      "Nothing to credit",
    );
  });
});

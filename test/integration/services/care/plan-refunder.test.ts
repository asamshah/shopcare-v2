/** Care::PlanRefunder on a recorded Care cover. */
import { describe, expect, it } from "vitest";
import { refundCarePlan } from "../../../../app/services/care/plan-refunder.server";
import { ItemRecorder } from "../../../../app/services/items/recorder.server";
import { buildCare, createShop } from "../../../support/factories";
import { FakeGraphql } from "../../../support/fake-graphql";
import { orderData, orderLine } from "../../../support/orders";

describe("refundCarePlan", () => {
  it("refunds the cover's Care line on its order, named in the note", async () => {
    const shop = await createShop();
    await buildCare(shop);
    const recorder = new ItemRecorder(shop);
    await recorder.record(
      orderData({ lines: [orderLine(), orderLine({ id: "2", productId: "700", variantId: "7001" })] }),
    );
    const cover = recorder.careResult.covers[0];
    const api = new FakeGraphql({
      suggestedRefund: { order: { currencyCode: "GBP", presentmentCurrencyCode: "GBP", suggestedRefund: { suggestedTransactions: [] } } },
      refundCreate: { refundCreate: { refund: { id: "gid://shopify/Refund/8" }, userErrors: [] } },
    });

    expect(await refundCarePlan(api, cover)).toBe("gid://shopify/Refund/8");
    expect(api.calls[1].variables.input).toMatchObject({
      orderId: "gid://shopify/Order/500",
      note: "ShopCare: 2-year Care refunded with its item",
      refundLineItems: [{ lineItemId: "gid://shopify/LineItem/2", quantity: 1, restockType: "NO_RESTOCK" }],
    });
  });

  it("refuses a cover without an order line", async () => {
    await expect(
      refundCarePlan(new FakeGraphql(), { shopifyOrderId: null, shopifyLineItemId: null, terms: {}, kind: "care" }),
    ).rejects.toThrow(/no order line/);
  });
});

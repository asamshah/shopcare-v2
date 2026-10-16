/** Port of Rails test/services/care/refund_handler_test.rb (+ Care::CreditIssuer). */
import type { CarePlan, Cover, Item, Shop } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../../../app/db.server";
import { careCoverFor, createCover } from "../../../../app/models/cover.server";
import { issueCareCredit } from "../../../../app/services/care/credit-issuer.server";
import { handleCareRefund } from "../../../../app/services/care/refund-handler.server";
import { processRefund } from "../../../../app/services/items/refund-processor.server";
import { buildCare, createItemFor, createShop, daysAgo } from "../../../support/factories";
import { FakeGraphql } from "../../../support/fake-graphql";
import { dbNotifyDeps } from "../../../support/quotes";

describe("handleCareRefund", () => {
  let shop: Shop;
  let plan: CarePlan;
  let item: Item;
  let cover: Cover;
  let api: FakeGraphql;

  const handle = (already: string[] = [], client = api) =>
    handleCareRefund(shop, cover.id, already, { client: async () => client, currency: async () => "GBP" });
  const usage = async () =>
    ((await prisma.cover.findUniqueOrThrow({ where: { id: cover.id } })).usage as { refund: Record<string, string> }).refund;
  const setCare = async (care: Record<string, string>) => {
    shop = await prisma.shop.update({ where: { id: shop.id }, data: { settings: { care, notifications: { flow: true } } } });
  };

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dbNotifyDeps();
    shop = await createShop({ shopifyDomain: "carerefund-test.myshopify.com", settings: { notifications: { flow: true } } });
    plan = (await buildCare(shop)).plan;
    item = await createItemFor(shop, {
      shopifyCustomerId: "77",
      customerEmail: "a@example.com",
      productTitle: "Boot",
      orderId: "500",
      orderLineId: "1",
      purchasedAt: daysAgo(7),
    });
    cover = await createCover(careCoverFor(item, plan, { orderId: "500", lineItemId: "2", pricePaid: 15 }));
    api = new FakeGraphql({
      suggestedRefund: {
        order: {
          currencyCode: "GBP",
          presentmentCurrencyCode: "GBP",
          suggestedRefund: {
            suggestedTransactions: [
              {
                gateway: "shopify_payments",
                amountSet: { shopMoney: { amount: "15.00", currencyCode: "GBP" } },
                parentTransaction: { id: "gid://shopify/OrderTransaction/1" },
              },
            ],
          },
        },
      },
      refundCreate: { refundCreate: { refund: { id: "gid://shopify/Refund/9" }, userErrors: [] } },
      discountCodeBasicCreate: {
        discountCodeBasicCreate: { codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/3" }, userErrors: [] },
      },
    });
  });

  it("refunds the Care line to the original payment", async () => {
    await handle();
    const input = api.calls.at(-1)!.variables.input as {
      refundLineItems: { lineItemId: string }[];
      transactions: Record<string, unknown>[];
    };
    expect(input.refundLineItems[0].lineItemId).toBe("gid://shopify/LineItem/2");
    expect([input.transactions[0].amount, input.transactions[0].kind, input.transactions[0].parentId]).toEqual([
      "15.00",
      "REFUND",
      "gid://shopify/OrderTransaction/1",
    ]);
    expect(await usage()).toMatchObject({ action: "refund", status: "done", refund_id: "gid://shopify/Refund/9" });
  });

  it("or issues a credit code for Care products (Flow trigger for merchants who email it)", async () => {
    await setCare({ refund_action: "credit", credit_days: "30" });
    await handle();
    const credit = await prisma.careCredit.findFirstOrThrow({ where: { shopId: shop.id } });
    expect(Number(credit.amount)).toBe(15);
    const input = api.calls.at(-1)!.variables.input as {
      customerGets: { items: { products: { productsToAdd: string[] } } };
      context: { customers: { add: string[] } };
    };
    expect(input.customerGets.items.products.productsToAdd).toEqual(["gid://shopify/Product/700"]);
    expect(input.context.customers.add).toEqual(["gid://shopify/Customer/77"]);
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({ where: { event: "care_credit_offer" } });
    expect((delivery.payload as { data: { creditCode: string } }).data.creditCode).toBe(credit.code);
    expect(await usage()).toMatchObject({ action: "credit", status: "done", code: credit.code });
  });

  it("issues one credit per cover", async () => {
    const withItem = await prisma.cover.findUniqueOrThrow({ where: { id: cover.id }, include: { item: true } });
    const first = await issueCareCredit(shop, api, withItem);
    expect((await issueCareCredit(shop, api, withItem)).id).toBe(first.id);
    expect(await prisma.careCredit.count()).toBe(1);
    expect(api.calls).toHaveLength(1);
  });

  it("leaves it to staff when set to manual, and skips Care the merchant already refunded", async () => {
    await setCare({ refund_action: "manual" });
    await handle();
    expect((await usage()).status).toBe("needs_action");
    await handle(["2"]);
    expect((await usage()).action).toBe("refunded_by_merchant");
    expect(api.calls).toEqual([]);
  });

  it("a Shopify error is recorded for staff, not raised", async () => {
    const failing = new FakeGraphql({
      suggestedRefund: () => {
        throw new Error("Order is archived");
      },
    });
    await handle([], failing);
    const refund = await usage();
    expect([refund.status, refund.error]).toEqual(["failed", "Order is archived"]);
  });

  it("refunding the item runs the Care refund", async () => {
    const calls: [number, string[]][] = [];
    await processRefund(shop, { refund_line_items: [{ line_item_id: 1, quantity: 1 }] }, {
      careHandler: async (coverId, already) => {
        calls.push([coverId, already]);
      },
    });
    expect(calls).toEqual([[cover.id, ["1"]]]);
    expect((await prisma.cover.findUniqueOrThrow({ where: { id: cover.id } })).status).toBe("cancelled");
  });
});

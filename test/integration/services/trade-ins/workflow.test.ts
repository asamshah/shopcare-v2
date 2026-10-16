/**
 * The Quoter and Workflow cases of Rails test/services/trade_ins/trade_ins_test.rb.
 * (Submission is parked with the storefront trade-in flow; see PORTING.)
 */
import type { Item, Shop, TradeInProgram } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../../../app/db.server";
import { createCover, careCoverFor } from "../../../../app/models/cover.server";
import { findItemWithCovers } from "../../../../app/models/item.server";
import { updateTradeInProgram } from "../../../../app/models/trade-in-program.server";
import { quoteCreditFor, TradeInQuoter } from "../../../../app/services/trade-ins/quoter.server";
import {
  approveTradeIn,
  creditTradeIn,
  InvalidTransition,
  receiveTradeIn,
  rejectTradeIn,
} from "../../../../app/services/trade-ins/workflow.server";
import { buildCare, buildProgram, createItemFor, createShop, createTradeInFor } from "../../../support/factories";
import { FakeGraphql } from "../../../support/fake-graphql";
import { dbNotifyDeps } from "../../../support/quotes";

let shop: Shop;
let program: TradeInProgram;
let item: Item;

beforeEach(async () => {
  dbNotifyDeps();
  shop = await createShop({ shopifyDomain: "tradein-test.myshopify.com", settings: { notifications: { flow: true } } });
  program = await buildProgram(shop);
  item = await createItemFor(shop, {
    shopifyCustomerId: "77",
    customerEmail: "a@example.com",
    customerName: "Sarah",
    productTitle: "Aria Boot",
    purchasedAt: new Date(Date.now() - 365 * 86_400_000),
    unitPrice: 120,
  });
});

const requested = (overrides: Record<string, unknown> = {}) =>
  createTradeInFor(shop, {
    tradeInProgramId: program.id,
    itemId: item.id,
    shopifyCustomerId: "77",
    customerEmail: "a@example.com",
    declaredGrade: "excellent",
    quotedCredit: 40,
    currency: "GBP",
    ...overrides,
  });
const ids = (tradeInId: number) => ({ shopId: shop.id, tradeInId });
const status = async (id: number) => (await prisma.tradeIn.findUniqueOrThrow({ where: { id } })).status;

describe("TradeInQuoter", () => {
  it("quotes the customer's item, including their Care plan's trade-in bonus", async () => {
    const { plan } = await buildCare(shop, { perks: { trade_in_bonus_percent: 10 } });
    await createCover(careCoverFor(item, plan));

    const quote = await new TradeInQuoter(shop).forItem(await findItemWithCovers(item.id));

    expect(Number(quoteCreditFor(quote!, "good"))).toBe(27.5);
    expect(Number(quote!.bonusPercent)).toBe(10);
  });

  it("percentage programs use what the customer paid; unknown items need a fixed all-products program", async () => {
    await updateTradeInProgram(program.id, { creditMode: "percent", grades: [{ label: "Good", value: 30 }] });

    const quote = await new TradeInQuoter(shop).forItem(await findItemWithCovers(item.id));
    expect(Number(quoteCreditFor(quote!, "good"))).toBe(36);
    expect(await new TradeInQuoter(shop).forUnknown()).toBeNull();
  });
});

describe("trade-in workflow", () => {
  it("approve, receive at a lower grade, and credit as store credit", async () => {
    const tradeIn = await requested();
    const api = new FakeGraphql({
      storeCreditAccountCredit: {
        storeCreditAccountCredit: {
          storeCreditAccountTransaction: { id: "gid://shopify/StoreCreditAccountCreditTransaction/1" },
          userErrors: [],
        },
      },
    });
    await prisma.shop.update({ where: { id: shop.id }, data: { settings: { notifications: { flow: true }, trade_in: { credit_method: "store_credit" } } } });

    await approveTradeIn({ ...ids(tradeIn.id), note: "Looks fine" });
    const received = await receiveTradeIn({ ...ids(tradeIn.id), grade: "good", credit: null });
    expect(Number(received.finalCredit)).toBe(25);
    const credited = await creditTradeIn({ ...ids(tradeIn.id), client: api });

    expect([credited.status, credited.creditMethod]).toEqual(["credited", "store_credit"]);
    expect(api.calls.at(-1)!.variables).toMatchObject({
      id: "gid://shopify/Customer/77",
      input: { creditAmount: { amount: "25.00", currencyCode: "GBP" } },
    });
    expect((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("traded_in");
    expect(credited.staffNote).toContain("Looks fine");
    const statuses = (await prisma.notificationDelivery.findMany({ where: { event: "trade_in_status_changed" }, orderBy: { id: "asc" } }))
      .map((d) => (d.payload as { data: { status: string } }).data.status);
    expect(statuses).toEqual(["approved", "received", "credited"]);
  });

  it("staff can set the credit; guests get a discount code; the item's cover ends", async () => {
    const { plan } = await buildCare(shop);
    const cover = await createCover(careCoverFor(item, plan));
    const tradeIn = await requested({ shopifyCustomerId: null });
    const api = new FakeGraphql({
      discountCodeBasicCreate: {
        discountCodeBasicCreate: { codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/1" }, userErrors: [] },
      },
    });

    await receiveTradeIn({ ...ids(tradeIn.id), grade: "worn", credit: "12.50" });
    const credited = await creditTradeIn({ ...ids(tradeIn.id), client: api });

    expect([credited.creditMethod, Number(credited.finalCredit)]).toEqual(["discount_code", 12.5]);
    expect(credited.creditReference).toMatch(/^TRADEIN-/);
    expect((await prisma.cover.findUniqueOrThrow({ where: { id: cover.id } })).status).toBe("cancelled");
  });

  it("credit is issued once, even if crediting is repeated concurrently", async () => {
    const tradeIn = await requested();
    await receiveTradeIn({ ...ids(tradeIn.id), grade: "good", credit: null });
    const issueCredit = vi.fn(async () => ({ method: "discount_code" as const, reference: "TRADEIN-1" }));

    const results = await Promise.allSettled([
      creditTradeIn({ ...ids(tradeIn.id), issueCredit }),
      creditTradeIn({ ...ids(tradeIn.id), issueCredit }),
    ]);

    expect(issueCredit).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(InvalidTransition);
    expect(await status(tradeIn.id)).toBe("credited");
  });

  it("a failed credit goes back to received so staff can retry", async () => {
    const tradeIn = await requested();
    await receiveTradeIn({ ...ids(tradeIn.id), grade: "good", credit: null });
    const issueCredit = vi.fn(async () => {
      throw new Error("Shopify is down");
    });

    await expect(creditTradeIn({ ...ids(tradeIn.id), issueCredit })).rejects.toThrow("Shopify is down");
    expect(await status(tradeIn.id)).toBe("received");
  });

  it("won't credit an item that is no longer active", async () => {
    const tradeIn = await requested();
    await receiveTradeIn({ ...ids(tradeIn.id), grade: "good", credit: null });
    await prisma.item.update({ where: { id: item.id }, data: { status: "refunded" } });
    const issueCredit = vi.fn();

    await expect(creditTradeIn({ ...ids(tradeIn.id), issueCredit })).rejects.toThrow(
      "This item is no longer active (refunded)",
    );
    expect(issueCredit).not.toHaveBeenCalled();
    expect(await status(tradeIn.id)).toBe("received");
  });

  it("steps must happen in order, within the shop", async () => {
    const tradeIn = await requested();
    await expect(creditTradeIn(ids(tradeIn.id))).rejects.toThrow("Receive the item first");
    await rejectTradeIn(ids(tradeIn.id));
    await expect(approveTradeIn(ids(tradeIn.id))).rejects.toThrow("Can't move a rejected trade-in to approved");
    await expect(receiveTradeIn({ ...ids(tradeIn.id), grade: "bogus", credit: null })).rejects.toThrow(
      "Enter the credit for this item",
    );
    const other = await createShop();
    await expect(approveTradeIn({ shopId: other.id, tradeInId: tradeIn.id })).rejects.toThrow("Trade-in not found.");
  });
});

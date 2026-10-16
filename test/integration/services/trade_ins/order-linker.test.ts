/** Port of the OrderLinker cases in Rails test/services/trade_ins/trade_ins_test.rb. */
import type { Shop } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import prisma from "../../../../app/db.server";
import { linkTradeInsToOrder } from "../../../../app/services/trade_ins/order-linker.server";
import { buildProgram, createItemFor, createShop, createTradeInFor } from "../../../support/factories";
import { orderData, orderLine } from "../../../support/orders";
import { dbNotifyDeps } from "../../../support/quotes";

describe("linkTradeInsToOrder", () => {
  let shop: Shop;
  beforeEach(async () => {
    dbNotifyDeps();
    shop = await createShop({ shopifyDomain: "ti-link.myshopify.com", settings: { notifications: { flow: true } } });
  });

  const pending = async (overrides: Record<string, unknown> = {}) => {
    const program = await buildProgram(shop);
    const item = await createItemFor(shop, { shopifyCustomerId: "77" });
    return createTradeInFor(shop, {
      tradeInProgramId: program.id,
      itemId: item.id,
      shopifyCustomerId: "77",
      source: "pdp",
      status: "pending_purchase",
      declaredGrade: "good",
      quotedCredit: 25,
      ...overrides,
    });
  };
  const order = (tradeInId: number, customerId = "77") =>
    orderData({ id: "900", name: "#900", customerId, lines: [orderLine({ properties: { _shopcare_trade_in: String(tradeInId) } })] });

  it("a product-page trade-in waits for its order to be paid, then becomes a request", async () => {
    const tradeIn = await pending();
    expect(await prisma.notificationDelivery.count()).toBe(0);

    const linked = await linkTradeInsToOrder(shop, order(tradeIn.id));

    expect(linked.map((t) => t.id)).toEqual([tradeIn.id]);
    const saved = await prisma.tradeIn.findUniqueOrThrow({ where: { id: tradeIn.id } });
    expect([saved.status, saved.shopifyOrderId, saved.orderName]).toEqual(["requested", "900", "#900"]);
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({ where: { event: "trade_in_status_changed" } });
    expect((delivery.payload as { data: { status: string } }).data.status).toBe("requested");

    expect(await linkTradeInsToOrder(shop, order(tradeIn.id))).toEqual([]); // retried webhook
  });

  it("a product-page trade-in can't be claimed by another customer's order", async () => {
    const tradeIn = await pending();
    await linkTradeInsToOrder(shop, order(tradeIn.id, "99"));
    expect((await prisma.tradeIn.findUniqueOrThrow({ where: { id: tradeIn.id } })).status).toBe("pending_purchase");
  });
});

/**
 * Port of the Care::Notices case in Rails test/services/care/notices_and_economics_test.rb:
 * an order with Care confirms it (care_activated). The "offer Care" half
 * moved to the daily care-offers job in v2 (test/integration/wiring/care-offers.test.ts).
 */
import { describe, expect, it } from "vitest";
import prisma from "../../../../app/db.server";
import { notifyCareActivated } from "../../../../app/services/care/notices.server";
import { ItemRecorder } from "../../../../app/services/items/recorder.server";
import { buildCare, createShop } from "../../../support/factories";
import { orderData, orderLine } from "../../../support/orders";
import { dbNotifyDeps } from "../../../support/quotes";

describe("notifyCareActivated", () => {
  it("an order with Care confirms it, once per cover", async () => {
    dbNotifyDeps();
    const shop = await createShop({ shopifyDomain: "notices.myshopify.com", settings: { notifications: { flow: true } } });
    await buildCare(shop);
    const recorder = new ItemRecorder(shop);
    await recorder.record(
      orderData({ lines: [orderLine(), orderLine({ id: "2", productId: "700", variantId: "7001", title: "2-year Care" })] }),
    );
    const covers = recorder.careResult.covers;

    await notifyCareActivated(shop, covers);
    await notifyCareActivated(shop, covers); // duplicate webhook

    const deliveries = await prisma.notificationDelivery.findMany({ where: { event: "care_activated" } });
    expect(deliveries.map((d) => d.channel)).toEqual(["flow"]);
    const data = (deliveries[0].payload as { data: Record<string, unknown> }).data;
    expect([data.carePlan, data.productTitle, data.coverEnds]).toEqual([
      "2-year Care",
      "Aria Boot — UK 7",
      covers[0].endsAt.toISOString().slice(0, 10),
    ]);
  });
});

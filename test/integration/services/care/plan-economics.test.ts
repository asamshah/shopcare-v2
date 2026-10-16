/** Care::PlanEconomics (ported for the admin's Care plan screens). */
import { describe, expect, it } from "vitest";
import prisma from "../../../../app/db.server";
import { careCoverFor, createCover } from "../../../../app/models/cover.server";
import { planEconomicsSummary } from "../../../../app/services/care/plan-economics.server";
import { buildCare, createItemFor, createQuotationFor, createRepairTicketFor, createShop, daysAgo } from "../../../support/factories";

describe("planEconomicsSummary", () => {
  it("sold, attach rate, claims cost, excess and refunds", async () => {
    const shop = await createShop();
    const { plan } = await buildCare(shop);
    const items = [];
    for (let i = 0; i < 4; i++) {
      items.push(await createItemFor(shop, { purchasedAt: daysAgo(1), eligibleCarePlanIds: [plan.id] }));
    }
    const covers = [];
    for (const item of items.slice(0, 2)) covers.push(await createCover(careCoverFor(item, plan, { pricePaid: 15 })));
    await prisma.cover.update({
      where: { id: covers[1].id },
      data: { status: "cancelled", usage: { refund: { action: "refund", status: "done" } } },
    });
    const ticket = await createRepairTicketFor(shop, {
      coverId: covers[0].id,
      status: "completed",
      costs: { parts: "4.5", labour: "10" },
    });
    await createQuotationFor(ticket.id, { status: "paid", coverId: covers[0].id, coverExcess: 5 });

    const s = await planEconomicsSummary(plan);

    expect([s.sold, s.active, s.cancelled, s.eligibleItems, s.claims, s.refunds]).toEqual([2, 1, 1, 4, 1, 1]);
    expect([s.revenue.toNumber(), s.claimsCost.toNumber(), s.excessCollected.toNumber(), s.net.toNumber()]).toEqual([
      15, 14.5, 5, 5.5,
    ]);
    expect([s.attachRate?.toNumber(), s.claimRate?.toNumber()]).toEqual([50, 50]);
  });
});

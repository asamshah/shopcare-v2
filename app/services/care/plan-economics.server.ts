/**
 * How a Care plan is doing: how often it's bought when it could be, what it
 * earns, and what its claims really cost (parts + labour from completed
 * repairs, less any excess collected). Port of Care::PlanEconomics.
 */
import { Prisma, type CarePlan } from "@prisma/client";
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import { d, jsonObject } from "../../models/validation.server";

export interface PlanSummary {
  sold: number;
  active: number;
  cancelled: number;
  eligibleItems: number;
  revenue: Prisma.Decimal;
  claims: number;
  claimsCost: Prisma.Decimal;
  excessCollected: Prisma.Decimal;
  refunds: number;
  /** Percent, one decimal place; null when nothing was eligible. */
  attachRate: Prisma.Decimal | null;
  claimRate: Prisma.Decimal | null;
  net: Prisma.Decimal;
}

/** Money went back to the customer (a credit code keeps the revenue in store). */
function refunded(usage: Prisma.JsonValue): boolean {
  const refund = jsonObject(jsonObject(usage).refund as Prisma.JsonValue);
  return refund.status === "done" && ["refund", "refunded_by_merchant"].includes(String(refund.action));
}

const percent = (part: number, whole: number) =>
  whole > 0 ? new Prisma.Decimal(part).div(whole).mul(100).toDecimalPlaces(1) : null;

export async function planEconomicsSummary(
  plan: Pick<CarePlan, "id" | "shopId" | "createdAt">,
  db: Db = prisma,
  now = new Date(),
): Promise<PlanSummary> {
  const covers = await db.cover.findMany({
    where: { carePlanId: plan.id },
    select: { id: true, status: true, endsAt: true, pricePaid: true, usage: true },
  });
  const coverIds = covers.map((c) => c.id);
  const tickets = await db.repairTicket.findMany({
    where: { shopId: plan.shopId, coverId: { in: coverIds } },
    select: { status: true, costs: true },
  });
  const [{ count: eligible }] = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM items
    WHERE shop_id = ${plan.shopId}
      AND eligible_care_plan_ids @> ${JSON.stringify([plan.id])}::jsonb
      AND created_at >= ${plan.createdAt}`;
  const excess = await db.quotation.aggregate({
    where: { coverId: { in: coverIds }, status: "paid" },
    _sum: { coverExcess: true },
  });

  const revenue = covers
    .filter((c) => !refunded(c.usage))
    .reduce((sum, c) => sum.add(d(c.pricePaid)), new Prisma.Decimal(0));
  const claimsCost = tickets
    .filter((t) => t.status === "completed")
    .reduce((sum, t) => {
      const costs = jsonObject(t.costs);
      return sum.add(d(costs.parts)).add(d(costs.labour));
    }, new Prisma.Decimal(0));
  const excessCollected = d(excess._sum.coverExcess);
  const sold = covers.length;

  return {
    sold,
    active: covers.filter((c) => c.status === "active" && c.endsAt > now).length,
    cancelled: covers.filter((c) => c.status === "cancelled").length,
    eligibleItems: Number(eligible),
    revenue,
    claims: tickets.length,
    claimsCost,
    excessCollected,
    refunds: covers.filter((c) => refunded(c.usage)).length,
    attachRate: percent(sold, Number(eligible)),
    claimRate: percent(tickets.length, sold),
    net: revenue.add(excessCollected).sub(claimsCost),
  };
}

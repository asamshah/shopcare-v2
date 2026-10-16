import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { formatDate } from "../lib/format";
import { decimal, formatMoney } from "../lib/format.server";
import { carePlanPriority, exclusionList, tradeInBonusPercent } from "../models/care-plan.server";
import { itemLabel } from "../models/item.server";
import { eligibilitySummary } from "../models/product-grouped.server";
import { tradeInEnabled } from "../models/shop.server";
import { orNotFound, parseId, requireAdmin } from "../services/admin/context.server";
import { shopCurrency } from "../services/admin/tickets.server";
import { planEconomicsSummary } from "../services/care/plan-economics.server";

// GET /app/care_plans/:id — a plan's economics and recent sales (Rails #show).
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const plan = orNotFound(
    await prisma.carePlan.findFirst({
      where: { id: parseId(params.id), shopId: shop.id },
      include: { productGroup: true },
    }),
  );
  const currency = shopCurrency(shop);
  const s = await planEconomicsSummary(plan);
  const covers = await prisma.cover.findMany({
    where: { carePlanId: plan.id },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: { item: true },
  });
  const now = new Date();
  const bonus = tradeInBonusPercent(plan);
  return {
    plan: {
      id: plan.id,
      name: plan.name,
      priceTerm: `${formatMoney(plan.price, currency)} · ${plan.termMonths} months from purchase`,
      excess: plan.excess.gt(0) ? `Excess ${formatMoney(plan.excess, currency)} per repair` : null,
      priority: carePlanPriority(plan),
      tradeInBonus: tradeInEnabled(shop) && bonus.gt(0) ? `${decimal(bonus)}% extra trade-in credit` : null,
      offered: `Offered on: ${eligibilitySummary(plan)}. Can be added up to ${plan.offerWindowDays} days after purchase.`,
      notCovered: `Not covered: ${exclusionList(plan).join("; ")}.`,
    },
    stats: [
      ["Sold", String(s.sold)],
      ["Attach rate", s.attachRate ? `${s.attachRate.toString()}%` : "—"],
      ["Active", String(s.active)],
      ["Revenue", formatMoney(s.revenue, currency)],
      ["Claims", s.claimRate ? `${s.claims} (${s.claimRate.toString()}% of plans)` : String(s.claims)],
      ["Cost of claims", formatMoney(s.claimsCost, currency)],
      ["Excess collected", formatMoney(s.excessCollected, currency)],
      ["Refunded", String(s.refunds)],
      ["Net", formatMoney(s.net, currency)],
    ],
    covers: covers.map((c) => {
      const state =
        c.status === "cancelled"
          ? ["neutral", "Cancelled"]
          : c.endsAt <= now
            ? ["neutral", "Expired"]
            : c.startsAt > now
              ? ["info", `Starts ${formatDate(c.startsAt)}`]
              : ["success", "Active"];
      return {
        id: c.id,
        itemId: c.itemId,
        item: itemLabel(c.item),
        customer: c.item.customerName?.trim() || c.item.customerEmail || "",
        paid: formatMoney(c.pricePaid ?? 0, currency),
        tone: state[0] as "neutral" | "info" | "success",
        state: state[1],
        ends: formatDate(c.endsAt),
      };
    }),
  };
};

export default function CarePlan() {
  const { plan, stats, covers } = useLoaderData<typeof loader>();
  return (
    <s-page heading={plan.name}>
      <s-link slot="breadcrumb-actions" href="/app/care_plans">
        Care plans
      </s-link>
      <s-button slot="primary-action" href={`/app/care_plans/${plan.id}/edit`}>
        Edit plan
      </s-button>
      <s-grid grid-template-columns="2fr 1fr" gap="base">
        <s-stack direction="block" gap="base">
          <s-section heading="Economics">
            <s-grid grid-template-columns="1fr 1fr 1fr" gap="base">
              {stats.map(([label, value]) => (
                <s-box key={label} padding="base" border="base" border-radius="base">
                  <s-stack direction="block" gap="small-500">
                    <s-text color="subdued">{label}</s-text>
                    <s-text type="strong">{value}</s-text>
                  </s-stack>
                </s-box>
              ))}
            </s-grid>
            <s-paragraph color="subdued">
              Attach rate is plans sold ÷ eligible items bought since the plan was created. Cost of claims is parts +
              labour on completed repairs under this plan (set your labour rate in Settings).
            </s-paragraph>
          </s-section>
          <s-section heading="Recent plans sold">
            {covers.length ? (
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header list-slot="primary">Item</s-table-header>
                  <s-table-header>Customer</s-table-header>
                  <s-table-header format="currency">Paid</s-table-header>
                  <s-table-header list-slot="inline">Status</s-table-header>
                  <s-table-header>Ends</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {covers.map((c) => (
                    <s-table-row key={c.id}>
                      <s-table-cell>
                        <s-link href={`/app/items/${c.itemId}`}>{c.item}</s-link>
                      </s-table-cell>
                      <s-table-cell>{c.customer}</s-table-cell>
                      <s-table-cell>{c.paid}</s-table-cell>
                      <s-table-cell>
                        <s-badge tone={c.tone}>{c.state}</s-badge>
                      </s-table-cell>
                      <s-table-cell>{c.ends}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            ) : (
              <s-paragraph color="subdued">None sold yet.</s-paragraph>
            )}
          </s-section>
        </s-stack>
        <s-stack direction="block" gap="base">
          <s-section heading="Terms">
            <s-stack direction="block" gap="small-300">
              <s-text>{plan.priceTerm}</s-text>
              <s-text>Covers all repairs</s-text>
              {plan.excess ? <s-text>{plan.excess}</s-text> : null}
              {plan.priority ? <s-text>Priority turnaround</s-text> : null}
              {plan.tradeInBonus ? <s-text>{plan.tradeInBonus}</s-text> : null}
              <s-text color="subdued">{plan.offered}</s-text>
              <s-text color="subdued">{plan.notCovered}</s-text>
            </s-stack>
          </s-section>
        </s-stack>
      </s-grid>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

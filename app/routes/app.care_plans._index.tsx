import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { formatMoney } from "../lib/format.server";
import { coverName } from "../models/cover.server";
import { itemLabel } from "../models/item.server";
import { jsonObject } from "../models/validation.server";
import { requireAdmin } from "../services/admin/context.server";
import { shopCurrency } from "../services/admin/tickets.server";
import { planEconomicsSummary } from "../services/care/plan-economics.server";

// GET /app/care_plans (Rails CarePlansController#index): each plan's economics,
// and Care covers whose automatic refund failed or needs the merchant.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const currency = shopCurrency(shop);
  const plans = await prisma.carePlan.findMany({
    where: { shopId: shop.id },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  const attention = await prisma.$queryRaw<{ id: number }[]>`
    SELECT id FROM covers WHERE shop_id = ${shop.id} AND kind = 'care'
      AND usage -> 'refund' ->> 'status' IN ('failed', 'needs_action')
    ORDER BY updated_at DESC LIMIT 20`;
  const covers = await prisma.cover.findMany({
    where: { id: { in: attention.map((r) => r.id) } },
    include: { item: true },
    orderBy: { updatedAt: "desc" },
  });
  return {
    plans: await Promise.all(
      plans.map(async (plan) => {
        const s = await planEconomicsSummary(plan);
        return {
          id: plan.id,
          name: plan.name,
          active: plan.active,
          price: formatMoney(plan.price, currency),
          term: `${plan.termMonths} months`,
          sold: s.sold,
          attachRate: s.attachRate ? `${s.attachRate.toString()}%` : "—",
          claims: s.claims,
          net: formatMoney(s.net, currency),
        };
      }),
    ),
    attention: covers.map((cover) => {
      const refund = jsonObject(jsonObject(cover.usage).refund as Prisma.JsonValue);
      return {
        id: cover.id,
        itemId: cover.itemId,
        itemLabel: itemLabel(cover.item),
        text: `${coverName(cover)} was cancelled when the item was refunded. ${
          refund.status === "failed"
            ? `The automatic ${String(refund.action ?? "")} failed (${String(refund.error ?? "")}).`
            : "Refund or credit it yourself."
        }`,
      };
    }),
  };
};

export default function CarePlans() {
  const d = useLoaderData<typeof loader>();
  return (
    <s-page heading="Care plans">
      <s-button slot="primary-action" variant="primary" href="/app/care_plans/new">
        Add Care plan
      </s-button>
      <s-section>
        <s-paragraph color="subdued">
          Care plans are paid cover your customers add on the product page, honoured as free repairs in your workshop.
          Create each plan as a product in Shopify (e.g. “2-year Care”), then link it here and set its terms.
        </s-paragraph>
      </s-section>
      {d.attention.length ? (
        <s-banner tone="warning" heading="Care plans that need you">
          <s-stack direction="block" gap="small-300">
            {d.attention.map((a) => (
              <s-text key={a.id}>
                <s-link href={`/app/items/${a.itemId}`}>{a.itemLabel}</s-link>: {a.text}
              </s-text>
            ))}
          </s-stack>
        </s-banner>
      ) : null}
      {d.plans.length ? (
        <s-section padding="none">
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header list-slot="primary">Plan</s-table-header>
              <s-table-header format="currency">Price</s-table-header>
              <s-table-header>Term</s-table-header>
              <s-table-header format="numeric">Sold</s-table-header>
              <s-table-header format="numeric">Attach rate</s-table-header>
              <s-table-header format="numeric">Claims</s-table-header>
              <s-table-header list-slot="inline" format="currency">
                Net
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.plans.map((p) => (
                <s-table-row key={p.id}>
                  <s-table-cell>
                    <s-link href={`/app/care_plans/${p.id}`}>{p.name}</s-link>
                    {p.active ? null : <s-badge tone="neutral">Off</s-badge>}
                  </s-table-cell>
                  <s-table-cell>{p.price}</s-table-cell>
                  <s-table-cell>{p.term}</s-table-cell>
                  <s-table-cell>{p.sold}</s-table-cell>
                  <s-table-cell>{p.attachRate}</s-table-cell>
                  <s-table-cell>{p.claims}</s-table-cell>
                  <s-table-cell>{p.net}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : (
        <s-section>
          <s-stack direction="block" gap="base" align-items="center">
            <s-heading>No Care plans yet</s-heading>
            <s-paragraph color="subdued">Earn on every order: offer Care on your product pages.</s-paragraph>
            <s-button variant="primary" href="/app/care_plans/new">
              Add Care plan
            </s-button>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

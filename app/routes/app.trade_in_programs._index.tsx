import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { decimal, formatMoney } from "../lib/format.server";
import { eligibilitySummaryText } from "../models/product-eligibility.server";
import { ORDERED, programGrades } from "../models/trade-in-program.server";
import { visibleWhere } from "../models/trade-in.server";
import { requireAdmin, requireTradeIn } from "../services/admin/context.server";
import { shopCurrency } from "../services/admin/tickets.server";

// GET /app/trade_in_programs (Rails TradeInProgramsController#index).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireTradeIn(shop);
  const currency = shopCurrency(shop);
  const [programs, counts] = await Promise.all([
    prisma.tradeInProgram.findMany({ where: { shopId: shop.id }, orderBy: ORDERED }),
    prisma.tradeIn.groupBy({
      by: ["tradeInProgramId"],
      where: { shopId: shop.id, ...visibleWhere },
      _count: { _all: true },
    }),
  ]);
  return {
    programs: programs.map((p) => ({
      id: p.id,
      name: p.name,
      active: p.active,
      takes: `${eligibilitySummaryText(p.eligibility) ?? "All products"}${p.maxAgeMonths ? `, up to ${p.maxAgeMonths} months old` : ""}`,
      credit: programGrades(p)
        .map((g) => `${g.label} ${p.creditMode === "fixed" ? formatMoney(g.value, currency) : `${decimal(g.value)}%`}`)
        .join(" · "),
      count: counts.find((c) => c.tradeInProgramId === p.id)?._count._all ?? 0,
    })),
  };
};

export default function TradeInPrograms() {
  const { programs } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Trade-in programs">
      <s-link slot="breadcrumb-actions" href="/app/trade_ins">
        Trade-ins
      </s-link>
      <s-button slot="primary-action" variant="primary" href="/app/trade_in_programs/new">
        Add program
      </s-button>
      <s-section>
        <s-paragraph color="subdued">
          A program sets which products you take back and what each condition is worth. Customers see the credit on the
          product page (“Add a trade-in”) and in the request form. The first active program that takes a product is used.
        </s-paragraph>
      </s-section>
      {programs.length ? (
        <s-section padding="none">
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header list-slot="primary">Program</s-table-header>
              <s-table-header>Takes</s-table-header>
              <s-table-header list-slot="inline">Credit</s-table-header>
              <s-table-header format="numeric">Trade-ins</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {programs.map((p) => (
                <s-table-row key={p.id}>
                  <s-table-cell>
                    <s-link href={`/app/trade_in_programs/${p.id}`}>{p.name}</s-link>
                    {p.active ? null : <s-badge tone="neutral">Off</s-badge>}
                  </s-table-cell>
                  <s-table-cell>{p.takes}</s-table-cell>
                  <s-table-cell>{p.credit}</s-table-cell>
                  <s-table-cell>{p.count}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : (
        <s-section>
          <s-stack direction="block" gap="base" align-items="center">
            <s-heading>No trade-in programs yet</s-heading>
            <s-paragraph color="subdued">
              Take back worn-out products for credit, and bring customers back to buy again.
            </s-paragraph>
            <s-button variant="primary" href="/app/trade_in_programs/new">
              Add program
            </s-button>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { Pagination } from "../components/pagination";
import { formatDate, statusLabel, tradeInTone } from "../lib/format";
import { formatMoney } from "../lib/format.server";
import { RECENT_ORDER, tradeInCredit, tradeInSearchWhere, visibleWhere } from "../models/trade-in.server";
import { requireAdmin, requireTradeIn } from "../services/admin/context.server";

const PER_PAGE = 25;
const FILTERS = ["requested", "approved", "received", "credited", "rejected", "cancelled"];

// GET /app/trade_ins — the trade-in queue (Rails TradeInsController#index).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireTradeIn(shop);
  const url = new URL(request.url);
  const raw = url.searchParams.get("status") ?? "";
  const status = FILTERS.includes(raw) ? raw : null;
  const q = url.searchParams.get("q")?.trim() ?? "";
  const page = Math.max(parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1);
  const and: Prisma.TradeInWhereInput[] = [{ shopId: shop.id }, visibleWhere];
  if (status) and.push({ status });
  if (q) and.push(await tradeInSearchWhere(q));
  const rows = await prisma.tradeIn.findMany({
    where: { AND: and },
    orderBy: RECENT_ORDER,
    skip: (page - 1) * PER_PAGE,
    take: PER_PAGE + 1,
  });
  const counts = await prisma.tradeIn.groupBy({
    by: ["status"],
    where: { shopId: shop.id, ...visibleWhere },
    _count: { _all: true },
  });
  return {
    status,
    query: q,
    page,
    hasNextPage: rows.length > PER_PAGE,
    filters: FILTERS.map((s) => ({
      status: s,
      label: statusLabel(s),
      tone: tradeInTone(s),
      count: counts.find((c) => c.status === s)?._count._all ?? 0,
    })),
    tradeIns: rows.slice(0, PER_PAGE).map((t) => ({
      id: t.id,
      product: t.productTitle,
      customer: t.customerName?.trim() || t.customerEmail || "",
      from: t.source === "pdp" ? `With order ${t.orderName ?? ""}` : "Request form",
      status: statusLabel(t.status),
      tone: tradeInTone(t.status),
      credit: formatMoney(tradeInCredit(t), t.currency),
      date: formatDate(t.createdAt),
    })),
  };
};

export default function TradeIns() {
  const d = useLoaderData<typeof loader>();
  const href = (page: number) => {
    const params = new URLSearchParams();
    if (d.status) params.set("status", d.status);
    if (d.query) params.set("q", d.query);
    params.set("page", String(page));
    return `/app/trade_ins?${params}`;
  };
  return (
    <s-page heading="Trade-ins">
      <s-button slot="primary-action" href="/app/trade_in_programs">
        Trade-in programs
      </s-button>
      <s-section padding="base">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" align-items="center">
            <s-link href="/app/trade_ins">
              <s-badge tone={d.status ? "neutral" : "info"}>All</s-badge>
            </s-link>
            {d.filters.map((f) => (
              <s-link key={f.status} href={`/app/trade_ins?status=${f.status}`}>
                <s-badge tone={f.tone}>
                  {f.label}
                  {f.count > 0 ? ` (${f.count})` : ""}
                </s-badge>
              </s-link>
            ))}
          </s-stack>
          <Form method="get" action="/app/trade_ins">
            <s-stack direction="inline" gap="small-200" align-items="end">
              <s-search-field
                label="Search"
                label-accessibility-visibility="exclusive"
                name="q"
                value={d.query}
                placeholder="Search customer, product or order #"
              ></s-search-field>
              {d.status ? <input type="hidden" name="status" value={d.status} /> : null}
              <s-button variant="secondary" type="submit">
                Search
              </s-button>
            </s-stack>
          </Form>
        </s-stack>
      </s-section>
      {d.tradeIns.length ? (
        <>
          <s-section padding="none">
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header list-slot="kicker">ID</s-table-header>
                <s-table-header list-slot="primary">Item</s-table-header>
                <s-table-header>Customer</s-table-header>
                <s-table-header>From</s-table-header>
                <s-table-header list-slot="inline">Status</s-table-header>
                <s-table-header format="currency">Credit</s-table-header>
                <s-table-header list-slot="secondary">Date</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {d.tradeIns.map((t) => (
                  <s-table-row key={t.id}>
                    <s-table-cell>
                      <s-link href={`/app/trade_ins/${t.id}`}>#{t.id}</s-link>
                    </s-table-cell>
                    <s-table-cell>{t.product}</s-table-cell>
                    <s-table-cell>{t.customer}</s-table-cell>
                    <s-table-cell>{t.from}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={t.tone}>{t.status}</s-badge>
                    </s-table-cell>
                    <s-table-cell>{t.credit}</s-table-cell>
                    <s-table-cell>{t.date}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-section>
          <Pagination page={d.page} hasNextPage={d.hasNextPage} href={href} />
        </>
      ) : (
        <s-section>
          <s-stack direction="block" gap="base" align-items="center">
            <s-heading>No trade-ins yet</s-heading>
            <s-paragraph color="subdued">
              They appear here when customers add a trade-in on the product page, or send a request from the trade-in
              form.
            </s-paragraph>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

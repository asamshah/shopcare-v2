import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Pagination } from "../components/pagination";
import { SetupWizard } from "../components/setup-wizard";
import { requireAdmin } from "../services/admin/context.server";
import { wizardData } from "../services/admin/setup.server";
import { ticketList } from "../services/admin/tickets.server";

// GET /app/tickets — the workbench home (Rails TicketsController#index).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const url = new URL(request.url);
  const page = Math.max(parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1);
  const list = await ticketList(shop, {
    status: url.searchParams.get("status"),
    q: url.searchParams.get("q"),
    page,
  });
  return { ...list, wizard: await wizardData(shop, url.searchParams.get("setup_step")) };
};

export default function Tickets() {
  const data = useLoaderData<typeof loader>();
  const href = (page: number) => {
    const params = new URLSearchParams();
    if (data.statusFilter) params.set("status", data.statusFilter);
    if (data.query) params.set("q", data.query);
    params.set("page", String(page));
    return `/app/tickets?${params}`;
  };

  return (
    <s-page heading="Repair tickets">
      {data.wizard ? <SetupWizard wizard={data.wizard} /> : null}

      <s-section padding="base">
        <s-stack direction="inline" gap="small-200" align-items="center">
          <s-link href="/app/tickets">
            <s-badge tone={data.statusFilter ? "neutral" : "info"}>All</s-badge>
          </s-link>
          {data.statuses.map((s) => (
            <s-link key={s.status} href={`/app/tickets?status=${s.status}`}>
              <s-badge tone={s.tone}>
                {s.label}
                {s.count > 0 ? ` (${s.count})` : ""}
              </s-badge>
            </s-link>
          ))}
        </s-stack>
      </s-section>

      <s-section padding="base">
        <Form method="get" action="/app/tickets">
          <s-stack direction="inline" gap="small-200" align-items="end">
            <s-search-field
              label="Search"
              label-accessibility-visibility="exclusive"
              name="q"
              value={data.query}
              placeholder="Search customer, email, product or order #"
            ></s-search-field>
            {data.statusFilter ? <input type="hidden" name="status" value={data.statusFilter} /> : null}
            <s-button variant="secondary" type="submit">
              Search
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      {data.tickets.length ? (
        <>
          <s-section padding="none">
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header list-slot="kicker">ID</s-table-header>
                <s-table-header list-slot="primary">Customer</s-table-header>
                <s-table-header>Product</s-table-header>
                <s-table-header list-slot="inline">Status</s-table-header>
                <s-table-header>Warranty</s-table-header>
                <s-table-header list-slot="labeled" format="currency">
                  Quote
                </s-table-header>
                <s-table-header list-slot="secondary">Date</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {data.tickets.map((t) => (
                  <s-table-row key={t.id}>
                    <s-table-cell>
                      <s-link href={`/app/tickets/${t.id}`}>#{t.id}</s-link>
                    </s-table-cell>
                    <s-table-cell>{t.customer}</s-table-cell>
                    <s-table-cell>{t.product}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={t.tone}>{t.status}</s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      {t.inWarranty ? <s-badge tone="info">Warranty</s-badge> : <s-text color="subdued">—</s-text>}
                    </s-table-cell>
                    <s-table-cell>{t.quote}</s-table-cell>
                    <s-table-cell>{t.date}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-section>
          <Pagination page={data.page} hasNextPage={data.hasNextPage} href={href} />
        </>
      ) : (
        <s-section>
          <s-stack direction="block" gap="base" align-items="center">
            <s-heading>No repair tickets yet</s-heading>
            <s-paragraph color="subdued">
              Tickets appear here when customers submit a repair request from your storefront.
            </s-paragraph>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

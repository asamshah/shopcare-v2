import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { disabledIf } from "../components/attrs";
import { Pagination } from "../components/pagination";
import { capitalize, formatDate, formatDateTime, formatMonthYear, itemStatusTone, registrationTone } from "../lib/format";
import { coverName } from "../models/cover.server";
import { activeCover, COVERS_ORDER, itemLabel, itemSearchWhere, RECENT_ORDER } from "../models/item.server";
import { settingsOf } from "../models/shop.server";
import { jsonObject } from "../models/validation.server";
import { requireAdmin } from "../services/admin/context.server";
import { redirectWithFlash } from "../services/admin/flash.server";
import { ITEM_FILTERS, startItemsImport } from "../services/admin/items.server";

const PER_PAGE = 25;

// GET /app/items (Rails ItemsController#index).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const url = new URL(request.url);
  const raw = url.searchParams.get("filter");
  const filter = (ITEM_FILTERS as readonly string[]).includes(raw ?? "") ? raw : null;
  const q = url.searchParams.get("q")?.trim() ?? "";
  const page = Math.max(parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1);
  const now = new Date();

  const and: Prisma.ItemWhereInput[] = [{ shopId: shop.id }];
  if (filter === "registrations") and.push({ source: "registration" });
  if (filter === "unverified") and.push({ registration: { status: "unverified" } });
  if (filter === "covered") {
    and.push({ covers: { some: { status: "active", startsAt: { lte: now }, endsAt: { gt: now } } } });
  }
  if (q) and.push(await itemSearchWhere(q));

  const rows = await prisma.item.findMany({
    where: { AND: and },
    orderBy: RECENT_ORDER,
    skip: (page - 1) * PER_PAGE,
    take: PER_PAGE + 1,
    include: { covers: { orderBy: COVERS_ORDER }, registration: true },
  });
  const unverifiedCount = await prisma.registration.count({ where: { shopId: shop.id, status: "unverified" } });
  const importState = jsonObject(settingsOf(shop).items_import as Prisma.JsonValue);
  const at = typeof importState.at === "string" ? new Date(importState.at) : null;

  return {
    filter,
    query: q,
    page,
    hasNextPage: rows.length > PER_PAGE,
    unverifiedCount,
    import: importState.status
      ? {
          status: String(importState.status),
          created: importState.created === undefined ? null : String(importState.created),
          at: at && !Number.isNaN(at.getTime()) ? formatDateTime(at) : String(importState.at ?? ""),
          running: ["queued", "running"].includes(String(importState.status)),
        }
      : null,
    items: rows.slice(0, PER_PAGE).map((item) => {
      const cover = activeCover(item, now);
      return {
        id: item.id,
        label: itemLabel(item),
        customer: item.customerName?.trim() || item.customerEmail || "",
        fromRegistration: item.source === "registration",
        registration: item.registration
          ? {
              status: item.registration.status,
              tone: registrationTone(item.registration.status),
              verified: item.registration.status === "verified",
            }
          : null,
        orderName: item.orderName ?? "",
        active: item.status === "active",
        status: capitalize(item.status),
        statusTone: itemStatusTone(item.status),
        cover: cover ? `${coverName(cover)} · until ${formatMonthYear(cover.endsAt)}` : null,
        purchased: formatDate(item.purchasedAt),
      };
    }),
  };
};

// POST /app/items — backfill Items from recent paid orders (Rails #import).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  await startItemsImport(shop);
  return redirectWithFlash("/app/items", { notice: "Importing recent orders. Refresh in a minute to see the items." });
};

export default function Items() {
  const d = useLoaderData<typeof loader>();
  const href = (page: number) => {
    const params = new URLSearchParams();
    if (d.filter) params.set("filter", d.filter);
    if (d.query) params.set("q", d.query);
    params.set("page", String(page));
    return `/app/items?${params}`;
  };
  const badge = (filter: string | null) => (d.filter === filter ? "info" : "neutral");

  return (
    <s-page heading="Items">
      <s-button slot="primary-action" href="/app/warranty_policies">
        Warranty policies
      </s-button>

      <s-section padding="base">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Every product your customers own gets an item: from paid orders automatically, or registered by the customer
            for things bought elsewhere. Cover and repairs hang off the item.
          </s-paragraph>
          <s-stack direction="inline" gap="small-200" align-items="center">
            <s-link href="/app/items">
              <s-badge tone={badge(null)}>All</s-badge>
            </s-link>
            <s-link href="/app/items?filter=covered">
              <s-badge tone={badge("covered")}>Under cover</s-badge>
            </s-link>
            <s-link href="/app/items?filter=registrations">
              <s-badge tone={badge("registrations")}>Registered</s-badge>
            </s-link>
            <s-link href="/app/items?filter=unverified">
              <s-badge tone={d.unverifiedCount > 0 ? "caution" : "neutral"}>
                To verify{d.unverifiedCount > 0 ? ` (${d.unverifiedCount})` : ""}
              </s-badge>
            </s-link>
          </s-stack>
          <Form method="get" action="/app/items">
            <s-stack direction="inline" gap="small-200" align-items="end">
              <s-search-field
                label="Search"
                label-accessibility-visibility="exclusive"
                name="q"
                value={d.query}
                placeholder="Search customer, email, product, order # or SKU"
              ></s-search-field>
              {d.filter ? <input type="hidden" name="filter" value={d.filter} /> : null}
              <s-button variant="secondary" type="submit">
                Search
              </s-button>
            </s-stack>
          </Form>
        </s-stack>
      </s-section>

      {d.items.length ? (
        <>
          <s-section padding="none">
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header list-slot="kicker">ID</s-table-header>
                <s-table-header list-slot="primary">Product</s-table-header>
                <s-table-header>Customer</s-table-header>
                <s-table-header list-slot="secondary">Source</s-table-header>
                <s-table-header list-slot="inline">Cover</s-table-header>
                <s-table-header>Purchased</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {d.items.map((item) => (
                  <s-table-row key={item.id}>
                    <s-table-cell>
                      <s-link href={`/app/items/${item.id}`}>#{item.id}</s-link>
                    </s-table-cell>
                    <s-table-cell>{item.label}</s-table-cell>
                    <s-table-cell>{item.customer}</s-table-cell>
                    <s-table-cell>
                      {item.fromRegistration ? (
                        <s-badge tone={item.registration?.tone ?? "neutral"}>
                          Registered
                          {item.registration && !item.registration.verified ? ` · ${item.registration.status}` : ""}
                        </s-badge>
                      ) : (
                        <s-text>{item.orderName}</s-text>
                      )}
                      {item.active ? null : <s-badge tone={item.statusTone}>{item.status}</s-badge>}
                    </s-table-cell>
                    <s-table-cell>
                      {item.cover ? <s-badge tone="success">{item.cover}</s-badge> : <s-text color="subdued">—</s-text>}
                    </s-table-cell>
                    <s-table-cell>{item.purchased}</s-table-cell>
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
            <s-heading>No items yet</s-heading>
            <s-paragraph color="subdued">
              Items are created when an order is paid. Import your recent orders to get started.
            </s-paragraph>
          </s-stack>
        </s-section>
      )}

      <s-section heading="Import from orders">
        <s-stack direction="block" gap="small-200">
          <s-paragraph color="subdued">
            Create items, with warranty cover, for orders paid in the last 60 days. Safe to run again: orders already
            imported are skipped.
          </s-paragraph>
          {d.import ? (
            <s-text color="subdued">
              Last import: {d.import.status}
              {d.import.created !== null ? `, ${d.import.created} new items` : ""} ({d.import.at})
            </s-text>
          ) : null}
          <Form method="post">
            <s-button type="submit" {...disabledIf(Boolean(d.import?.running))}>
              Import recent orders
            </s-button>
          </Form>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

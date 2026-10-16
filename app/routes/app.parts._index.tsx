import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { DownloadButton } from "../components/download-button";
import { formatMoney } from "../lib/format.server";
import { ORDERED, partOptionNames, partSearchWhere, quantityLabel, varies } from "../models/part.server";
import { lowVariantIds, variantLow } from "../models/part-variant.server";
import { requireAdmin, requireParts } from "../services/admin/context.server";
import { shopCurrency } from "../services/admin/tickets.server";

const PER_PAGE = 50;

// GET /app/parts — Workshop inventory (Rails PartsController#index).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireParts(shop);
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const filter = url.searchParams.get("filter") === "low" ? "low" : null;
  const lowIds = await lowVariantIds(shop.id);
  const and: Prisma.PartWhereInput[] = [{ shopId: shop.id }];
  if (q) and.push(await partSearchWhere(q));
  if (filter) and.push({ variants: { some: { id: { in: lowIds } } } });
  const parts = await prisma.part.findMany({
    where: { AND: and },
    orderBy: ORDERED,
    take: PER_PAGE,
    include: { variants: { orderBy: { id: "asc" } } },
  });
  const lowCount = await prisma.partVariant.count({ where: { id: { in: lowIds }, part: { active: true } } });
  const currency = shopCurrency(shop);
  return {
    query: q,
    filter,
    lowCount,
    parts: parts.map((p) => {
      const low = p.variants.filter((v) => variantLow(v, p)).length;
      const total = p.variants.reduce((sum, v) => sum.add(v.onHand), p.packSize.mul(0));
      return {
        id: p.id,
        name: p.name,
        active: p.active,
        sku: p.sku ?? "",
        variants: varies(p) ? `${p.variants.length} (${partOptionNames(p).join(" × ")})` : "—",
        onHand: quantityLabel(p, total),
        low: low > 0 ? (varies(p) ? `${low} low` : "Low") : null,
        cost: `${formatMoney(p.costPerUnit, currency)} / ${p.unit}`,
      };
    }),
  };
};

export default function Parts() {
  const d = useLoaderData<typeof loader>();
  return (
    <s-page heading="Workshop inventory">
      <s-button slot="primary-action" variant="primary" href="/app/parts/new">
        Add part
      </s-button>
      <s-button slot="secondary-actions" href="/app/parts/reorder">
        Reorder list
      </s-button>
      <s-button slot="secondary-actions" href="/app/parts/imports/new">
        Import parts
      </s-button>
      <DownloadButton slot="secondary-actions" href="/app/parts/export">
        Export parts
      </DownloadButton>

      <s-section padding="base">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" align-items="center">
            <s-link href="/app/parts">
              <s-badge tone={d.filter === "low" ? "neutral" : "info"}>All</s-badge>
            </s-link>
            <s-link href="/app/parts?filter=low">
              <s-badge tone={d.lowCount > 0 ? "warning" : "neutral"}>
                Low stock{d.lowCount > 0 ? ` (${d.lowCount})` : ""}
              </s-badge>
            </s-link>
          </s-stack>
          <Form method="get" action="/app/parts">
            <s-stack direction="inline" gap="small-200" align-items="end">
              <s-search-field
                label="Search"
                label-accessibility-visibility="exclusive"
                name="q"
                value={d.query}
                placeholder="Search name or SKU"
              ></s-search-field>
              {d.filter ? <input type="hidden" name="filter" value={d.filter} /> : null}
              <s-button variant="secondary" type="submit">
                Search
              </s-button>
            </s-stack>
          </Form>
        </s-stack>
      </s-section>

      {d.parts.length ? (
        <s-section padding="none">
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header list-slot="primary">Part</s-table-header>
              <s-table-header>SKU</s-table-header>
              <s-table-header>Variants</s-table-header>
              <s-table-header list-slot="inline" format="numeric">
                On hand
              </s-table-header>
              <s-table-header format="currency">Unit cost</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.parts.map((p) => (
                <s-table-row key={p.id}>
                  <s-table-cell>
                    <s-link href={`/app/parts/${p.id}`}>{p.name}</s-link>
                    {p.active ? null : <s-badge tone="neutral">Inactive</s-badge>}
                  </s-table-cell>
                  <s-table-cell>{p.sku}</s-table-cell>
                  <s-table-cell>{p.variants}</s-table-cell>
                  <s-table-cell>
                    {p.onHand}
                    {p.low ? <s-badge tone="warning">{p.low}</s-badge> : null}
                  </s-table-cell>
                  <s-table-cell>{p.cost}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : (
        <s-section>
          <s-stack direction="block" gap="base" align-items="center">
            <s-heading>{d.query || d.filter ? "No matching parts" : "No parts in your workshop inventory yet"}</s-heading>
            <s-paragraph color="subdued">
              Add the parts and materials your workshop uses for repairs: soles, heels, eyelets, adhesive. Then add them
              to your repair services&apos; recipes. This is separate from your Shopify product inventory.
            </s-paragraph>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

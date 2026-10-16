import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { DownloadButton } from "../components/download-button";
import { decimal } from "../lib/format.server";
import { quantityLabel } from "../models/part.server";
import { variantLabel } from "../models/part-variant.server";
import { requireAdmin, requireParts } from "../services/admin/context.server";
import { csvResponse, today } from "../services/admin/parts.server";
import { reorderCsv, reorderRows } from "../services/parts/reorder-list.server";

// GET /app/parts/reorder — what to buy; ?format=csv downloads it (Rails PartsController#reorder).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireParts(shop);
  if (new URL(request.url).searchParams.get("format") === "csv") {
    return csvResponse(await reorderCsv(shop.id), `workshop-inventory-reorder-${today()}.csv`);
  }
  const rows = await reorderRows(shop.id);
  return {
    rows: rows.map(({ variant, suggestedPacks, suggestedUnits }) => {
      const part = variant.part;
      return {
        id: variant.id,
        partId: part.id,
        part: part.name,
        variant: variantLabel(variant, part),
        sku: variant.sku?.trim() ? variant.sku : part.sku ?? "",
        onHand: quantityLabel(part, variant.onHand),
        reorderAt: quantityLabel(part, part.reorderLevel),
        toOrder: part.packSize.eq(1)
          ? quantityLabel(part, suggestedUnits)
          : `${suggestedPacks} × ${decimal(part.packSize)} (${quantityLabel(part, suggestedUnits)})`,
      };
    }),
  };
};

export default function Reorder() {
  const { rows } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Parts to reorder">
      <s-link slot="breadcrumb-actions" href="/app/parts">
        Workshop inventory
      </s-link>
      <DownloadButton slot="primary-action" variant="primary" href="/app/parts/reorder?format=csv">
        Download CSV
      </DownloadButton>
      {rows.length ? (
        <s-section padding="none">
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header list-slot="primary">Part</s-table-header>
              <s-table-header>Variant</s-table-header>
              <s-table-header>SKU</s-table-header>
              <s-table-header list-slot="inline" format="numeric">
                On hand
              </s-table-header>
              <s-table-header format="numeric">Reorder at</s-table-header>
              <s-table-header format="numeric">To order</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((r) => (
                <s-table-row key={r.id}>
                  <s-table-cell>
                    <s-link href={`/app/parts/${r.partId}`}>{r.part}</s-link>
                  </s-table-cell>
                  <s-table-cell>{r.variant}</s-table-cell>
                  <s-table-cell>{r.sku}</s-table-cell>
                  <s-table-cell>{r.onHand}</s-table-cell>
                  <s-table-cell>{r.reorderAt}</s-table-cell>
                  <s-table-cell>{r.toOrder}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : (
        <s-section>
          <s-stack direction="block" gap="base" align-items="center">
            <s-heading>Nothing to reorder</s-heading>
            <s-paragraph color="subdued">Every part is above its reorder level.</s-paragraph>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

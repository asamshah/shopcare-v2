import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { DownloadButton } from "../components/download-button";
import { createPartImport, PART_IMPORT_MODES } from "../models/part-import.server";
import { requireAdmin, requireParts, STAFF } from "../services/admin/context.server";
import { flashUrl, redirectWithFlash } from "../services/admin/flash.server";
import { field, readForm } from "../services/admin/form.server";
import { today } from "../services/admin/parts.server";
import { MAX_BYTES, MAX_ROWS, utf8 } from "../services/parts/csv-import.server";

const COLUMNS: [string, string][] = [
  ["part_name", "The part's name. Needed for a new part."],
  ["part_sku", "The part's SKU. Parts are matched on it, or on their name if they have no SKU yet."],
  ["unit", "What stock is counted in: each, pair, metre, ml or g."],
  ["pack_size", "Units per pack you buy, e.g. 100 eyelets."],
  ["cost_per_unit", "Cost of one unit, without a currency sign."],
  ["reorder_level", "Flag a variant low at or below this."],
  ["reorder_quantity", "Units to buy above the reorder level."],
  ["model, size, colour", "The variant's options. Leave them blank for a part with no variants. Every row of a part sets the same ones."],
  ["variant_sku", "The variant's SKU. Variants are matched on it, or on their options."],
  ["on_hand", "Stock on the shelf, in the part's unit. Only used when you set stock counts; blank means not counted."],
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireParts(shop);
  const to = today();
  const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  return { maxMb: MAX_BYTES / 1024 / 1024, maxRows: MAX_ROWS.toLocaleString("en-GB"), from, to };
};

// POST — store the file and show its preview (Rails PartImportsController#create).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireParts(shop);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES + 64 * 1024) {
    return redirectWithFlash("/app/parts/imports/new", { alert: `That file is over ${MAX_BYTES / 1024 / 1024} MB.` });
  }
  const form = await readForm(request);
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return redirectWithFlash("/app/parts/imports/new", { alert: "Choose a CSV file to import." });
  }
  if (file.size > MAX_BYTES) {
    return redirectWithFlash("/app/parts/imports/new", { alert: `That file is over ${MAX_BYTES / 1024 / 1024} MB.` });
  }
  const mode = field(form, "mode");
  const filename = file.name.split(/[\\/]/).pop()?.trim().slice(0, 255) || "workshop-inventory.csv";
  const imported = await createPartImport({
    shopId: shop.id,
    filename,
    mode: (PART_IMPORT_MODES as readonly string[]).includes(mode) ? mode : "parts",
    csvData: utf8(new Uint8Array(await file.arrayBuffer())),
    createdBy: STAFF,
  });
  return redirect(flashUrl(`/app/parts/imports/${imported.id}`));
};

export default function NewPartImport() {
  const d = useLoaderData<typeof loader>();
  return (
    <s-page heading="Import and export parts">
      <s-link slot="breadcrumb-actions" href="/app/parts">
        Workshop inventory
      </s-link>
      <DownloadButton slot="primary-action" href="/app/parts/imports/template">
        Download template
      </DownloadButton>

      <s-section heading="Import parts">
        <Form method="post" encType="multipart/form-data">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Save your parts spreadsheet as CSV (one row per variant) and upload it. You&apos;ll see what it changes
              before anything is saved.
            </s-paragraph>
            <s-stack direction="block" gap="small-300">
              <label htmlFor="part-import-file">
                <s-text type="strong">CSV file</s-text>
              </label>
              <input id="part-import-file" type="file" name="file" accept=".csv,text/csv" required />
              <s-text color="subdued">
                Up to {d.maxMb} MB and {d.maxRows} rows.
              </s-text>
            </s-stack>
            <s-select label="What to import" name="mode">
              <s-option value="parts" selected>
                Add or update parts only (stock unchanged)
              </s-option>
              <s-option value="stock">Also set stock counts from this file (on_hand)</s-option>
            </s-select>
            <s-stack direction="inline">
              <s-button type="submit" variant="primary">
                Preview import
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Columns">
        <s-table variant="auto">
          <s-table-header-row>
            <s-table-header list-slot="primary">Column</s-table-header>
            <s-table-header>What it holds</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {COLUMNS.map(([column, help]) => (
              <s-table-row key={column}>
                <s-table-cell>
                  <s-text type="strong">{column}</s-text>
                </s-table-cell>
                <s-table-cell>{help}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        <s-paragraph color="subdued">
          Blank part details leave what&apos;s already saved. Setting stock counts records each difference as a stock
          count in the part&apos;s history.
        </s-paragraph>
      </s-section>

      <s-section heading="Export">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" align-items="center">
            <DownloadButton href="/app/parts/export">Export parts</DownloadButton>
            <s-text color="subdued">Every part and variant with today&apos;s stock, in the import columns.</s-text>
          </s-stack>
          <StockUsedExport from={d.from} to={d.to} />
          <s-text color="subdued">
            Stock used on repairs, received and counted between the two dates, for updating your spreadsheet.
          </s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function StockUsedExport({ from, to }: { from: string; to: string }) {
  // The dates are read from the fields when the button is clicked.
  const value = (id: string) => (document.getElementById(id) as (HTMLElement & { value?: string }) | null)?.value ?? "";
  return (
    <s-stack direction="inline" gap="small-200" align-items="end">
      <s-date-field label="From" name="from" id="stock-used-from" value={from}></s-date-field>
      <s-date-field label="To" name="to" id="stock-used-to" value={to}></s-date-field>
      <DownloadButton
        href={() =>
          `/app/parts/stock_used?${new URLSearchParams({ from: value("stock-used-from"), to: value("stock-used-to") })}`
        }
      >
        Export stock used
      </DownloadButton>
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

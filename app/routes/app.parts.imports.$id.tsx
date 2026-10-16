import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { PartImport, Prisma } from "@prisma/client";
import prisma from "../db.server";
import { formatDateTime, pluralize } from "../lib/format";
import { decimal } from "../lib/format.server";
import { isApplied, isStockImport } from "../models/part-import.server";
import { ValidationError } from "../models/validation.server";
import { orNotFound, parseId, requireAdmin, requireParts, STAFF } from "../services/admin/context.server";
import { redirectWithFlash } from "../services/admin/flash.server";
import { CsvImport, type ImportSummary, InvalidImportError } from "../services/parts/csv-import.server";

const SHOWN = 200;

async function findImport(shopId: number, id: string | undefined) {
  return orNotFound(await prisma.partImport.findFirst({ where: { id: parseId(id), shopId } }));
}

const build = (record: PartImport) =>
  CsvImport.build(record.shopId, record.csvData, { mode: record.mode, filename: record.filename });

/** The preview, checked against the parts as they are now. */
async function preview(record: PartImport) {
  const importer = await build(record);
  const summary = importer.summary();
  const stock = isStockImport(record);
  return {
    id: record.id,
    filename: record.filename,
    appliedAt: record.appliedAt ? formatDateTime(record.appliedAt) : null,
    description: `${
      stock ? "Add or update parts, and set stock counts from the file." : "Add or update parts only; stock stays as it is."
    } ${pluralize(summary.rows, "row")} read.`,
    counts: [
      ["New parts", summary.parts_created],
      ["Parts updated", summary.parts_updated],
      ["New variants", summary.variants_created],
      ["Variants updated", summary.variants_updated],
      ...(stock ? [["Stock counts", summary.stock_changes]] : []),
      ["Errors", summary.errors],
    ] as [string, number][],
    errors: importer.errors.slice(0, SHOWN).map((e, i) => ({ key: i, row: e.row ?? "—", message: e.message })),
    moreErrors: Math.max(importer.errors.length - SHOWN, 0),
    stockChanges: importer.stockChanges.slice(0, SHOWN).map((c, i) => ({
      key: i,
      part: c.partName,
      variant: c.variantLabel,
      from: decimal(c.from),
      to: decimal(c.to),
      change: `${c.delta.gt(0) ? "+" : ""}${decimal(c.delta)}`,
    })),
    moreStockChanges: Math.max(importer.stockChanges.length - SHOWN, 0),
    canApply: importer.valid && !isApplied(record),
  };
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireParts(shop);
  return { ...(await preview(await findImport(shop.id, params.id))), alert: null as string | null };
};

function appliedNotice(summary: ImportSummary, stock: boolean): string {
  const parts = summary.parts_created + summary.parts_updated;
  const variants = summary.variants_created + summary.variants_updated;
  let notice = `Imported: ${parts} ${parts === 1 ? "part" : "parts"} and ${variants} ${
    variants === 1 ? "variant" : "variants"
  } added or updated`;
  if (stock) notice += `, ${summary.stock_changes} stock ${summary.stock_changes === 1 ? "count" : "counts"} set`;
  return `${notice}.`;
}

// POST — apply the import (Rails PartImportsController#apply): everything or nothing.
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireParts(shop);
  const record = await findImport(shop.id, params.id);
  if (isApplied(record)) return redirectWithFlash("/app/parts", { notice: "That import was already applied." });
  // Claim it first, so a double-click can't apply the file twice.
  const claimed = await prisma.partImport.updateMany({
    where: { id: record.id, appliedAt: null },
    data: { appliedAt: new Date() },
  });
  if (claimed.count === 0) return redirectWithFlash("/app/parts", { notice: "That import was already applied." });
  try {
    const summary = await (await build(record)).apply({ by: STAFF });
    await prisma.partImport.update({
      where: { id: record.id },
      data: { summary: summary as unknown as Prisma.InputJsonValue },
    });
    return redirectWithFlash("/app/parts", { notice: appliedNotice(summary, isStockImport(record)) });
  } catch (error) {
    await prisma.partImport.update({ where: { id: record.id }, data: { appliedAt: null } });
    if (error instanceof InvalidImportError || error instanceof ValidationError) {
      const reloaded = await findImport(shop.id, params.id);
      return data({ ...(await preview(reloaded)), alert: `Nothing was imported: ${error.message}.` }, { status: 422 });
    }
    throw error;
  }
};

export default function PartImportPreview() {
  const loaded = useLoaderData<typeof loader>();
  const failed = useActionData<typeof action>();
  const d = failed ?? loaded;
  return (
    <s-page heading="Import preview">
      <s-link slot="breadcrumb-actions" href="/app/parts/imports/new">
        Import and export parts
      </s-link>
      {d.alert ? <s-banner tone="critical" heading={d.alert}></s-banner> : null}
      {d.appliedAt ? (
        <s-banner tone="info" heading="Already imported">
          This file was imported on {d.appliedAt}.
        </s-banner>
      ) : null}

      <s-section heading={d.filename}>
        <s-stack direction="block" gap="base">
          <s-paragraph>{d.description}</s-paragraph>
          <s-grid grid-template-columns="repeat(auto-fit, minmax(140px, 1fr))" gap="base">
            {d.counts.map(([label, count]) => (
              <s-box key={label} padding="base" border="base" border-radius="base">
                <s-stack direction="block" gap="small-300">
                  <s-text color="subdued">{label}</s-text>
                  <s-heading>{count}</s-heading>
                </s-stack>
              </s-box>
            ))}
          </s-grid>
        </s-stack>
      </s-section>

      {d.errors.length ? (
        <s-section heading="Fix these rows, then upload the file again">
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header list-slot="secondary" format="numeric">
                Row
              </s-table-header>
              <s-table-header list-slot="primary">Problem</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.errors.map((e) => (
                <s-table-row key={e.key}>
                  <s-table-cell>{e.row}</s-table-cell>
                  <s-table-cell>{e.message}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          {d.moreErrors ? <s-paragraph color="subdued">And {d.moreErrors} more.</s-paragraph> : null}
        </s-section>
      ) : null}

      {d.stockChanges.length ? (
        <s-section heading="Stock changes">
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header list-slot="primary">Part</s-table-header>
              <s-table-header>Variant</s-table-header>
              <s-table-header format="numeric">Now</s-table-header>
              <s-table-header format="numeric">From file</s-table-header>
              <s-table-header list-slot="inline" format="numeric">
                Change
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.stockChanges.map((c) => (
                <s-table-row key={c.key}>
                  <s-table-cell>{c.part}</s-table-cell>
                  <s-table-cell>{c.variant}</s-table-cell>
                  <s-table-cell>{c.from}</s-table-cell>
                  <s-table-cell>{c.to}</s-table-cell>
                  <s-table-cell>{c.change}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          {d.moreStockChanges ? <s-paragraph color="subdued">And {d.moreStockChanges} more.</s-paragraph> : null}
        </s-section>
      ) : null}

      <s-section>
        <s-stack direction="inline" gap="small-200">
          {d.canApply ? (
            <Form method="post">
              <s-button type="submit" variant="primary">
                Import
              </s-button>
            </Form>
          ) : null}
          <s-button href="/app/parts/imports/new">Upload another file</s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

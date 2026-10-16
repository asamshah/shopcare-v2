import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useSubmit } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import prisma from "../db.server";
import { decimal, formatMoney } from "../lib/format.server";
import { partsCost, ORDERED } from "../models/repair-service.server";
import { partsEnabled, useRepairCollection as rememberRepairCollection } from "../models/shop.server";
import { requireAdmin } from "../services/admin/context.server";
import { redirectWithFlash } from "../services/admin/flash.server";
import { field, parse, readForm, zText } from "../services/admin/form.server";
import { shopCurrency } from "../services/admin/tickets.server";
import { errorSummary } from "../shopify/graphql.server";
import { repairProductsConfigured } from "../shopify/repair-products.server";
import {
  importRepairServices,
  repairProductSettings,
  shopifyRepairCatalog,
} from "../services/repairs/service-import.server";

// GET /app/repair_services (Rails RepairServicesController#index).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const withParts = partsEnabled(shop);
  const currency = shopCurrency(shop);
  const services = await prisma.repairService.findMany({
    where: { shopId: shop.id },
    orderBy: [{ active: "desc" }, ...ORDERED],
    include: { components: { orderBy: { id: "asc" }, include: { part: true } } },
  });
  return {
    partsEnabled: withParts,
    catalogConfigured: repairProductsConfigured(repairProductSettings(shop)),
    services: await Promise.all(
      services.map(async (s) => ({
        id: s.id,
        title: s.title,
        active: s.active,
        price: formatMoney(s.price, currency),
        labour: `${s.labourMinutes} min`,
        recipe: s.components.length
          ? s.components.map((c) => `${c.part.name} × ${decimal(c.quantity)}`).join(", ")
          : "No parts yet",
        partsCost: withParts ? formatMoney(await partsCost(s.id), currency) : "",
      })),
    ),
  };
};

// POST — pull the repair products from Shopify: from a collection just chosen
// with the resource picker, else from Settings (Rails #sync).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin } = await requireAdmin(request);
  const form = await readForm(request);
  const { collectionId, collectionTitle } = parse(
    z.object({ collectionId: zText(100), collectionTitle: zText(255) }),
    { collectionId: field(form, "collection_id"), collectionTitle: field(form, "collection_title") },
  );
  const current = collectionId ? await rememberRepairCollection(shop, collectionId, collectionTitle) : shop;
  try {
    const counts = await importRepairServices(current.id, shopifyRepairCatalog(current, admin));
    if (!counts) {
      return redirectWithFlash("/app/repair_services", {
        alert: "Choose the collection that holds your repair products, or set a tag in Settings.",
      });
    }
    return redirectWithFlash("/app/repair_services", {
      notice: `Synced: ${counts.added} added, ${counts.updated} updated, ${counts.deactivated} switched off.`,
    });
  } catch (error) {
    return redirectWithFlash("/app/repair_services", {
      alert: `We couldn't read your products from Shopify: ${errorSummary(error)}`,
    });
  }
};

export default function RepairServices() {
  const d = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const submit = useSubmit();

  async function pickCollection() {
    const selection = await shopify.resourcePicker({ type: "collection", action: "select", multiple: false });
    if (!selection || !selection.length) return;
    const chosen = selection[0] as { id: string; title: string };
    submit({ collection_id: chosen.id.split("/").pop() ?? "", collection_title: chosen.title }, { method: "post" });
  }

  return (
    <s-page heading="Repair services">
      <s-section>
        <s-stack direction="block" gap="small-200">
          <s-paragraph color="subdued">
            Your repair services (e.g. “Full resole”) are Shopify products, in a collection or with a tag (
            <s-link href="/app/settings">Settings → Repairs</s-link>). They&apos;re what you quote from, and what Care
            plans cover.
            {d.partsEnabled
              ? " Give each one its labour time and the parts it uses, and ShopCare plans the parts for every repair and works out its real cost."
              : null}
          </s-paragraph>
          <Form method="post">
            <s-stack direction="inline" gap="small-200">
              <s-button type="button" onClick={pickCollection}>
                Import from a collection
              </s-button>
              {d.catalogConfigured ? (
                <s-button variant="primary" type="submit" icon="refresh">
                  Sync from Shopify
                </s-button>
              ) : null}
            </s-stack>
          </Form>
        </s-stack>
      </s-section>

      {d.services.length ? (
        <s-section padding="none">
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header list-slot="primary">Service</s-table-header>
              <s-table-header format="currency">Price</s-table-header>
              {d.partsEnabled ? (
                <>
                  <s-table-header format="numeric">Labour</s-table-header>
                  <s-table-header list-slot="secondary">Recipe</s-table-header>
                  <s-table-header format="currency">Parts cost</s-table-header>
                </>
              ) : null}
            </s-table-header-row>
            <s-table-body>
              {d.services.map((s) => (
                <s-table-row key={s.id}>
                  <s-table-cell>
                    <s-link href={`/app/repair_services/${s.id}`}>{s.title}</s-link>
                    {s.active ? null : <s-badge tone="neutral">Not in Shopify</s-badge>}
                  </s-table-cell>
                  <s-table-cell>{s.price}</s-table-cell>
                  {d.partsEnabled ? (
                    <>
                      <s-table-cell>{s.labour}</s-table-cell>
                      <s-table-cell>{s.recipe}</s-table-cell>
                      <s-table-cell>{s.partsCost}</s-table-cell>
                    </>
                  ) : null}
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : (
        <s-section>
          <s-stack direction="block" gap="base" align-items="center">
            <s-heading>No repair services yet</s-heading>
            <s-paragraph color="subdued">Import your repair products from Shopify to get started.</s-paragraph>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

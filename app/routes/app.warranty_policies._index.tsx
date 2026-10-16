import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { plainNumber } from "../lib/money";
import { eligibilitySummary } from "../models/product-grouped.server";
import { requireAdmin } from "../services/admin/context.server";

// GET /app/warranty_policies (Rails WarrantyPoliciesController#index).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const [policies, counts] = await Promise.all([
    prisma.warrantyPolicy.findMany({
      where: { shopId: shop.id },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      include: { productGroup: true },
    }),
    prisma.cover.groupBy({
      by: ["warrantyPolicyId"],
      where: { shopId: shop.id, status: "active" },
      _count: { _all: true },
    }),
  ]);
  const countBy = new Map(counts.map((c) => [c.warrantyPolicyId, c._count._all]));
  return {
    policies: policies.map((p) => ({
      id: p.id,
      name: p.name,
      active: p.active,
      appliesTo: eligibilitySummary(p),
      cover: `${p.months} months · ${p.outcome === "free" ? "Free repair" : `${plainNumber(p.discountPercent)}% off`}`,
      activeCovers: countBy.get(p.id) ?? 0,
    })),
  };
};

export default function WarrantyPolicies() {
  const { policies } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Warranty policies">
      <s-link slot="breadcrumb-actions" href="/app/items">
        Items
      </s-link>
      <s-button slot="primary-action" variant="primary" href="/app/warranty_policies/new">
        Add policy
      </s-button>
      <s-section>
        <s-paragraph color="subdued">
          When an order is paid (or a product is registered), each item gets cover from the first active policy below
          that matches the product. Changing a policy only affects items bought afterwards.
        </s-paragraph>
      </s-section>
      {policies.length ? (
        <s-section padding="none">
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header list-slot="primary">Policy</s-table-header>
              <s-table-header>Applies to</s-table-header>
              <s-table-header list-slot="inline">Cover</s-table-header>
              <s-table-header format="numeric">Active cover</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {policies.map((p) => (
                <s-table-row key={p.id}>
                  <s-table-cell>
                    <s-link href={`/app/warranty_policies/${p.id}`}>{p.name}</s-link>
                    {p.active ? null : <s-badge tone="neutral">Off</s-badge>}
                  </s-table-cell>
                  <s-table-cell>{p.appliesTo}</s-table-cell>
                  <s-table-cell>{p.cover}</s-table-cell>
                  <s-table-cell>{p.activeCovers}</s-table-cell>
                  <s-table-cell>
                    <s-link href={`/app/warranty_policies/${p.id}`}>Edit</s-link>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : (
        <s-section>
          <s-stack direction="block" gap="base" align-items="center">
            <s-heading>No warranty policies yet</s-heading>
            <s-paragraph color="subdued">Add one to give customers cover on the products they buy.</s-paragraph>
            <s-button variant="primary" href="/app/warranty_policies/new">
              Add policy
            </s-button>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

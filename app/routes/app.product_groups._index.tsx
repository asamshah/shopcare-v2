import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { productGroupSummary } from "../models/product-group.server";
import { requireAdmin } from "../services/admin/context.server";

// GET /app/product_groups (Rails ProductGroupsController#index).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const [groups, plans, policies] = await Promise.all([
    prisma.productGroup.findMany({ where: { shopId: shop.id }, orderBy: [{ name: "asc" }, { id: "asc" }] }),
    prisma.carePlan.groupBy({ by: ["productGroupId"], where: { shopId: shop.id }, _count: { _all: true } }),
    prisma.warrantyPolicy.groupBy({ by: ["productGroupId"], where: { shopId: shop.id }, _count: { _all: true } }),
  ]);
  const count = (rows: { productGroupId: number | null; _count: { _all: number } }[], id: number) =>
    rows.find((r) => r.productGroupId === id)?._count._all ?? 0;
  return {
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      summary: productGroupSummary(g),
      policies: count(policies, g.id),
      plans: count(plans, g.id),
    })),
  };
};

export default function ProductGroups() {
  const { groups } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Product groups">
      <s-button slot="primary-action" variant="primary" href="/app/product_groups/new">
        Add group
      </s-button>
      <s-section>
        <s-paragraph color="subdued">
          Define which products go together once, for example “Leather boots” or “Sandals”. Warranty policies and Care
          plans then apply to a group, or to all products.
        </s-paragraph>
      </s-section>
      {groups.length ? (
        <s-section padding="none">
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header list-slot="primary">Group</s-table-header>
              <s-table-header>Products</s-table-header>
              <s-table-header format="numeric">Warranty policies</s-table-header>
              <s-table-header format="numeric">Care plans</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {groups.map((g) => (
                <s-table-row key={g.id}>
                  <s-table-cell>
                    <s-link href={`/app/product_groups/${g.id}`}>{g.name}</s-link>
                  </s-table-cell>
                  <s-table-cell>{g.summary}</s-table-cell>
                  <s-table-cell>{g.policies}</s-table-cell>
                  <s-table-cell>{g.plans}</s-table-cell>
                  <s-table-cell>
                    <s-link href={`/app/product_groups/${g.id}`}>Edit</s-link>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : (
        <s-section>
          <s-stack direction="block" gap="base" align-items="center">
            <s-heading>No product groups yet</s-heading>
            <s-paragraph color="subdued">Without groups, warranty and Care apply to all products.</s-paragraph>
            <s-button variant="primary" href="/app/product_groups/new">
              Add group
            </s-button>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

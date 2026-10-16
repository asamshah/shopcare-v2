import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useActionData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { ProductGroupForm } from "../components/product-group-form";
import { createProductGroup } from "../models/product-group.server";
import { saveOr422 } from "../services/admin/catalog-forms.server";
import { requireAdmin } from "../services/admin/context.server";
import { redirectWithFlash } from "../services/admin/flash.server";
import { readForm } from "../services/admin/form.server";
import { readGroup } from "../services/admin/product-groups.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdmin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const { values, input } = readGroup(await readForm(request));
  return saveOr422(values, async () => {
    await createProductGroup({ shopId: shop.id, ...input });
    return redirectWithFlash("/app/product_groups", { notice: "Product group created." });
  });
};

export default function NewProductGroup() {
  const failed = useActionData<typeof action>();
  return (
    <s-page heading="New product group">
      <s-link slot="breadcrumb-actions" href="/app/product_groups">
        Product groups
      </s-link>
      <ProductGroupForm
        values={failed?.values ?? { name: "", rule: "collections", collections: [], tags: "", productType: "" }}
        errors={failed?.errors}
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

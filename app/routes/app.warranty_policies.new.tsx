import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { WarrantyPolicyForm } from "../components/warranty-policy-form";
import { createWarrantyPolicy } from "../models/warranty-policy.server";
import { saveOr422 } from "../services/admin/catalog-forms.server";
import { requireAdmin } from "../services/admin/context.server";
import { redirectWithFlash } from "../services/admin/flash.server";
import { readForm } from "../services/admin/form.server";
import { nextPolicyPosition, policyFormData, policyPreview, readPolicy, type PolicyValues } from "../services/admin/warranty.server";

const defaults = async (shopId: number): Promise<PolicyValues> => ({
  name: "12-month warranty",
  months: "12",
  active: true,
  outcome: "free",
  discountPercent: "100",
  coveredFaults: "",
  productGroupId: null,
  position: String(await nextPolicyPosition(shopId)),
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  return policyFormData(shop.id, await defaults(shop.id));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const { values, input } = await readPolicy(shop.id, await readForm(request), await defaults(shop.id));
  return saveOr422(
    values,
    async () => {
      await createWarrantyPolicy({ shopId: shop.id, ...input });
      return redirectWithFlash("/app/warranty_policies", { notice: "Warranty policy created." });
    },
    { preview: policyPreview(values) },
  );
};

export default function NewWarrantyPolicy() {
  const loaded = useLoaderData<typeof loader>();
  const failed = useActionData<typeof action>();
  const values = failed?.values ?? loaded.values;
  return (
    <s-page heading="New warranty policy">
      <s-link slot="breadcrumb-actions" href="/app/warranty_policies">
        Warranty policies
      </s-link>
      <WarrantyPolicyForm
        values={values}
        groups={loaded.groups}
        preview={failed?.preview ?? loaded.preview}
        errors={failed?.errors}
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

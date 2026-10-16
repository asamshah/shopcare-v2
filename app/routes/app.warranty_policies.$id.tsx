import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { WarrantyPolicyForm } from "../components/warranty-policy-form";
import { updateWarrantyPolicy } from "../models/warranty-policy.server";
import { saveOr422 } from "../services/admin/catalog-forms.server";
import { orNotFound, parseId, requireAdmin } from "../services/admin/context.server";
import { redirectWithFlash } from "../services/admin/flash.server";
import { field, readForm } from "../services/admin/form.server";
import { policyFormData, policyPreview, policyValues, readPolicy } from "../services/admin/warranty.server";

async function findPolicy(shopId: number, id: string | undefined) {
  return orNotFound(await prisma.warrantyPolicy.findFirst({ where: { id: parseId(id), shopId } }));
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const policy = await findPolicy(shop.id, params.id);
  return { id: policy.id, title: policy.name, ...(await policyFormData(shop.id, policyValues(policy))) };
};

// Save or delete. Editing only affects items bought afterwards; existing cover keeps its terms.
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const policy = await findPolicy(shop.id, params.id);
  const form = await readForm(request);
  if (field(form, "intent") === "delete") {
    await prisma.warrantyPolicy.delete({ where: { id: policy.id } });
    return redirectWithFlash("/app/warranty_policies", {
      notice: "Warranty policy deleted. Existing cover is unaffected.",
    });
  }
  const { values, input } = await readPolicy(shop.id, form, policyValues(policy));
  return saveOr422(
    values,
    async () => {
      await updateWarrantyPolicy(policy.id, input);
      return redirectWithFlash("/app/warranty_policies", { notice: "Warranty policy saved." });
    },
    { preview: policyPreview(values) },
  );
};

export default function EditWarrantyPolicy() {
  const loaded = useLoaderData<typeof loader>();
  const failed = useActionData<typeof action>();
  return (
    <s-page heading={loaded.title}>
      <s-link slot="breadcrumb-actions" href="/app/warranty_policies">
        Warranty policies
      </s-link>
      <WarrantyPolicyForm
        values={failed?.values ?? loaded.values}
        groups={loaded.groups}
        preview={failed?.preview ?? loaded.preview}
        errors={failed?.errors}
      />
      <s-section heading="Delete policy">
        <s-stack direction="block" gap="small-200">
          <s-paragraph color="subdued">Items that already have this cover keep it. New purchases won&apos;t get it.</s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value="delete" />
            <s-button tone="critical" type="submit">
              Delete policy
            </s-button>
          </Form>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

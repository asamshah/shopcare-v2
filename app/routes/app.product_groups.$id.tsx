import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { ProductGroupForm } from "../components/product-group-form";
import { toSentence } from "../lib/inflections";
import { deleteProductGroup, updateProductGroup } from "../models/product-group.server";
import { saveOr422 } from "../services/admin/catalog-forms.server";
import { orNotFound, parseId, requireAdmin } from "../services/admin/context.server";
import { redirectWithFlash } from "../services/admin/flash.server";
import { field, readForm } from "../services/admin/form.server";
import { groupValues, readGroup } from "../services/admin/product-groups.server";
import { storefrontChanged } from "../services/storefront/storefront-sync.server";

async function findGroup(shopId: number, id: string | undefined) {
  return orNotFound(await prisma.productGroup.findFirst({ where: { id: parseId(id), shopId } }));
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const group = await findGroup(shop.id, params.id);
  const [policies, plans] = await Promise.all([
    prisma.warrantyPolicy.findMany({ where: { productGroupId: group.id }, select: { name: true } }),
    prisma.carePlan.findMany({ where: { productGroupId: group.id }, select: { name: true } }),
  ]);
  const users = [...policies, ...plans].map((r) => r.name);
  return { id: group.id, title: group.name, values: groupValues(group), usedBy: users.length ? toSentence(users) : null };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const group = await findGroup(shop.id, params.id);
  const form = await readForm(request);
  if (field(form, "intent") === "delete") {
    if (await deleteProductGroup(group.id)) {
      return redirectWithFlash("/app/product_groups", { notice: "Product group deleted." });
    }
    return redirectWithFlash(`/app/product_groups/${group.id}`, {
      alert: "This group is used by a warranty policy or Care plan. Move them to another group first.",
    });
  }
  const { values, input } = readGroup(form);
  return saveOr422(values, async () => {
    await updateProductGroup(group.id, input);
    await storefrontChanged(shop);
    return redirectWithFlash("/app/product_groups", { notice: "Product group saved." });
  });
};

export default function EditProductGroup() {
  const loaded = useLoaderData<typeof loader>();
  const failed = useActionData<typeof action>();
  return (
    <s-page heading={loaded.title}>
      <s-link slot="breadcrumb-actions" href="/app/product_groups">
        Product groups
      </s-link>
      <ProductGroupForm values={failed?.values ?? loaded.values} errors={failed?.errors} />
      <s-section heading="Delete group">
        <s-stack direction="block" gap="small-200">
          {loaded.usedBy ? (
            <s-paragraph color="subdued">
              Used by {loaded.usedBy}. Move them to another group before deleting this one.
            </s-paragraph>
          ) : (
            <>
              <s-paragraph color="subdued">No warranty policy or Care plan uses this group.</s-paragraph>
              <Form method="post">
                <input type="hidden" name="intent" value="delete" />
                <s-button tone="critical" type="submit">
                  Delete group
                </s-button>
              </Form>
            </>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

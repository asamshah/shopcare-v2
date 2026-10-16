import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { PartForm } from "../components/part-form";
import { capitalize } from "../lib/format";
import { createPart, OPTION_NAMES, UNITS, varies } from "../models/part.server";
import { saveOr422 } from "../services/admin/catalog-forms.server";
import { requireAdmin, requireParts } from "../services/admin/context.server";
import { flashUrl } from "../services/admin/flash.server";
import { readForm } from "../services/admin/form.server";
import { NEW_PART, readPart, UNIT_LABELS } from "../services/admin/parts.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireParts(shop);
  return {
    values: NEW_PART,
    units: UNITS.map((u) => ({ value: u, label: UNIT_LABELS[u] })),
    options: OPTION_NAMES.map((o) => ({ value: o, label: capitalize(o) })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireParts(shop);
  const { values, input } = readPart(await readForm(request), NEW_PART);
  return saveOr422(values, async () => {
    const part = await createPart({ shopId: shop.id, ...input });
    return redirect(
      flashUrl(`/app/parts/${part.id}`, { notice: varies(part) ? "Part created. Now add its variants." : "Part created." }),
    );
  });
};

export default function NewPart() {
  const loaded = useLoaderData<typeof loader>();
  const failed = useActionData<typeof action>();
  return (
    <s-page heading="New part">
      <s-link slot="breadcrumb-actions" href="/app/parts">
        Workshop inventory
      </s-link>
      <PartForm values={failed?.values ?? loaded.values} units={loaded.units} options={loaded.options} errors={failed?.errors} />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

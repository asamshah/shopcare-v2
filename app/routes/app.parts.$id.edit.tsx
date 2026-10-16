import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { PartForm } from "../components/part-form";
import { capitalize } from "../lib/format";
import { OPTION_NAMES, partOptionNames, UNITS, updatePart, varies } from "../models/part.server";
import { invalid, saveOr422 } from "../services/admin/catalog-forms.server";
import { orNotFound, parseId, requireAdmin, requireParts } from "../services/admin/context.server";
import { flashUrl, redirectWithFlash } from "../services/admin/flash.server";
import { field, readForm } from "../services/admin/form.server";
import { partValues, readPart, UNIT_LABELS } from "../services/admin/parts.server";

async function findPart(shopId: number, id: string | undefined) {
  return orNotFound(await prisma.part.findFirst({ where: { id: parseId(id), shopId } }));
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireParts(shop);
  const part = await findPart(shop.id, params.id);
  return {
    id: part.id,
    title: part.name,
    values: partValues(part),
    units: UNITS.map((u) => ({ value: u, label: UNIT_LABELS[u] })),
    options: OPTION_NAMES.map((o) => ({ value: o, label: capitalize(o) })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireParts(shop);
  const part = await findPart(shop.id, params.id);
  const form = await readForm(request);

  if (field(form, "intent") === "delete") {
    if ((await prisma.ticketPart.count({ where: { partId: part.id } })) > 0) {
      return redirectWithFlash(`/app/parts/${part.id}`, {
        alert: "This part has been used on repairs, so it can't be deleted. Mark it inactive instead.",
      });
    }
    await prisma.part.delete({ where: { id: part.id } });
    return redirectWithFlash("/app/parts", { notice: "Part deleted." });
  }

  const { values, input } = readPart(form, partValues(part));
  const before = [...partOptionNames(part)].sort().join(",");
  const optionsChanged = [...input.optionNames].sort().join(",") !== before;
  if (optionsChanged) {
    const variantIds = (await prisma.partVariant.findMany({ where: { partId: part.id }, select: { id: true } })).map((v) => v.id);
    const history =
      (await prisma.stockMovement.count({ where: { partVariantId: { in: variantIds } } })) +
      (await prisma.ticketPart.count({ where: { partVariantId: { in: variantIds } } }));
    if (history > 0) {
      return invalid(["Option names can't change once the part's variants have stock history"], {
        ...values,
        optionNames: partOptionNames(part),
      });
    }
  }
  return saveOr422(values, async () => {
    const saved = await prisma.$transaction(async (tx) => {
      // Rebuilt for the new options.
      if (optionsChanged) await tx.partVariant.deleteMany({ where: { partId: part.id } });
      return updatePart(part.id, input, tx);
    });
    return redirect(
      flashUrl(`/app/parts/${part.id}`, {
        notice: optionsChanged && varies(saved) ? "Part saved. Now add its variants." : "Part saved.",
      }),
    );
  });
};

export default function EditPart() {
  const loaded = useLoaderData<typeof loader>();
  const failed = useActionData<typeof action>();
  return (
    <s-page heading={`Edit ${loaded.title}`}>
      <s-link slot="breadcrumb-actions" href={`/app/parts/${loaded.id}`}>
        {loaded.title}
      </s-link>
      <PartForm values={failed?.values ?? loaded.values} units={loaded.units} options={loaded.options} errors={failed?.errors} />
      <s-section heading="Delete part">
        <s-stack direction="block" gap="small-200">
          <s-paragraph color="subdued">Parts already used on repairs can&apos;t be deleted; mark them inactive instead.</s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value="delete" />
            <s-button tone="critical" type="submit">
              Delete part
            </s-button>
          </Form>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

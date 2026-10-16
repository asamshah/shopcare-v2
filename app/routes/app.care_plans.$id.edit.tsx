import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { CarePlanForm } from "../components/care-plan-form";
import { formatMoney } from "../lib/format.server";
import { STANDARD_EXCLUSIONS, updateCarePlan } from "../models/care-plan.server";
import { tradeInEnabled } from "../models/shop.server";
import { invalid, saveOr422 } from "../services/admin/catalog-forms.server";
import { orNotFound, parseId, requireAdmin } from "../services/admin/context.server";
import { redirectWithFlash } from "../services/admin/flash.server";
import { field, readForm } from "../services/admin/form.server";
import { planValues, readPlan, termsPreview } from "../services/admin/care-plans.server";
import { groupOptions } from "../services/admin/setup.server";
import { shopCurrency } from "../services/admin/tickets.server";

async function findPlan(shopId: number, id: string | undefined) {
  return orNotFound(await prisma.carePlan.findFirst({ where: { id: parseId(id), shopId } }));
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const plan = await findPlan(shop.id, params.id);
  const values = planValues(plan, `Variant ${plan.shopifyVariantId} · ${formatMoney(plan.price, shopCurrency(shop))}`);
  return {
    id: plan.id,
    title: plan.name,
    values,
    groups: await groupOptions(shop.id),
    terms: termsPreview(values, shop),
    standardExclusions: STANDARD_EXCLUSIONS.join("; "),
    tradeInEnabled: tradeInEnabled(shop),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop, admin } = await requireAdmin(request);
  const plan = await findPlan(shop.id, params.id);
  const form = await readForm(request);
  if (field(form, "intent") === "delete") {
    if ((await prisma.cover.count({ where: { carePlanId: plan.id } })) > 0) {
      await prisma.carePlan.update({ where: { id: plan.id }, data: { active: false } });
      return redirectWithFlash("/app/care_plans", {
        notice: "This plan has been sold, so it's been switched off rather than deleted.",
      });
    }
    await prisma.carePlan.delete({ where: { id: plan.id } });
    return redirectWithFlash("/app/care_plans", { notice: "Care plan deleted." });
  }
  const base = planValues(plan, null);
  const { values, input, errors } = await readPlan(shop, admin, form, base, plan);
  const extra = { terms: termsPreview(values, shop) };
  if (errors.length) return invalid(errors, values, extra);
  return saveOr422(
    values,
    async () => {
      await updateCarePlan(plan.id, input);
      return redirectWithFlash(`/app/care_plans/${plan.id}`, { notice: "Care plan saved." });
    },
    extra,
  );
};

export default function EditCarePlan() {
  const loaded = useLoaderData<typeof loader>();
  const failed = useActionData<typeof action>();
  return (
    <s-page heading={`Edit ${loaded.title}`}>
      <s-link slot="breadcrumb-actions" href={`/app/care_plans/${loaded.id}`}>
        {loaded.title}
      </s-link>
      <CarePlanForm
        values={failed?.values ?? loaded.values}
        groups={loaded.groups}
        terms={failed?.terms ?? loaded.terms}
        standardExclusions={loaded.standardExclusions}
        tradeInEnabled={loaded.tradeInEnabled}
        errors={failed?.errors}
      />
      <s-section heading="Delete plan">
        <s-stack direction="block" gap="small-200">
          <s-paragraph color="subdued">
            A plan that&apos;s been sold is switched off instead, so existing customers keep their cover.
          </s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value="delete" />
            <s-button tone="critical" type="submit">
              Delete plan
            </s-button>
          </Form>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

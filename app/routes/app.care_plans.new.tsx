import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { CarePlanForm } from "../components/care-plan-form";
import { createCarePlan, STANDARD_EXCLUSIONS } from "../models/care-plan.server";
import { tradeInEnabled } from "../models/shop.server";
import { invalid, saveOr422 } from "../services/admin/catalog-forms.server";
import { requireAdmin } from "../services/admin/context.server";
import { flashUrl } from "../services/admin/flash.server";
import { readForm } from "../services/admin/form.server";
import { nextPlanPosition, type PlanValues, readPlan, termsPreview } from "../services/admin/care-plans.server";
import { groupOptions } from "../services/admin/setup.server";
import { storefrontChanged } from "../services/storefront/storefront-sync.server";

const defaults = async (shopId: number): Promise<PlanValues> => ({
  name: "2-year Care",
  shopifyVariantId: "",
  variantLabel: null,
  termMonths: "24",
  offerWindowDays: "30",
  active: true,
  excess: "0",
  priority: false,
  tradeInBonusPercent: "0",
  productGroupId: null,
  position: String(await nextPlanPosition(shopId)),
  exclusions: "",
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const values = await defaults(shop.id);
  return {
    values,
    groups: await groupOptions(shop.id),
    terms: termsPreview(values, shop),
    standardExclusions: STANDARD_EXCLUSIONS.join("; "),
    tradeInEnabled: tradeInEnabled(shop),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin } = await requireAdmin(request);
  const { values, input, errors } = await readPlan(shop, admin, await readForm(request), await defaults(shop.id), null);
  const extra = { terms: termsPreview(values, shop) };
  if (errors.length) return invalid(errors, values, extra);
  return saveOr422(
    values,
    async () => {
      const plan = await createCarePlan({ shopId: shop.id, ...input });
      await storefrontChanged(shop);
      return redirect(flashUrl(`/app/care_plans/${plan.id}`, { notice: "Care plan created." }));
    },
    extra,
  );
};

export default function NewCarePlan() {
  const loaded = useLoaderData<typeof loader>();
  const failed = useActionData<typeof action>();
  return (
    <s-page heading="New Care plan">
      <s-link slot="breadcrumb-actions" href="/app/care_plans">
        Care plans
      </s-link>
      <CarePlanForm
        values={failed?.values ?? loaded.values}
        groups={loaded.groups}
        terms={failed?.terms ?? loaded.terms}
        standardExclusions={loaded.standardExclusions}
        tradeInEnabled={loaded.tradeInEnabled}
        errors={failed?.errors}
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

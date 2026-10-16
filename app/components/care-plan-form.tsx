import { useState } from "react";
import { Form } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { checkedIf } from "./attrs";
import { ErrorBanner } from "./error-banner";
import { ProductGroupSelect, type GroupOption } from "./product-group-select";

export interface PlanFormValues {
  name: string;
  shopifyVariantId: string;
  variantLabel: string | null;
  termMonths: string;
  offerWindowDays: string;
  active: boolean;
  excess: string;
  priority: boolean;
  tradeInBonusPercent: string;
  productGroupId: number | null;
  position: string;
  exclusions: string;
}

/** Rails care_plans/_form. */
export function CarePlanForm({
  values,
  groups,
  terms,
  standardExclusions,
  tradeInEnabled,
  errors,
}: {
  values: PlanFormValues;
  groups: GroupOption[];
  terms: string[];
  standardExclusions: string;
  tradeInEnabled: boolean;
  errors?: string[];
}) {
  const shopify = useAppBridge();
  const [variant, setVariant] = useState({
    id: values.shopifyVariantId,
    label: values.shopifyVariantId ? values.variantLabel ?? `Variant ${values.shopifyVariantId}` : "No product chosen",
  });

  async function pickVariant() {
    const selection = await shopify.resourcePicker({ type: "variant", action: "select", multiple: false });
    if (!selection || !selection.length) return;
    const chosen = selection[0] as { id: string; title?: string; price?: string; product?: { title?: string } };
    const label = [chosen.product?.title, chosen.title].filter(Boolean).join(" — ") + (chosen.price ? ` · ${chosen.price}` : "");
    setVariant({ id: chosen.id.split("/").pop() ?? "", label });
  }

  return (
    <Form method="post">
      <input type="hidden" name="intent" value="save" />
      <s-stack direction="block" gap="base">
        <ErrorBanner errors={errors} />
        <s-section heading="Care product">
          <s-stack direction="block" gap="small-200">
            <s-paragraph color="subdued">
              Create the plan as a product in Shopify first (for example “2-year Care”, priced at what you&apos;ll
              charge). Its price and title come from Shopify.
            </s-paragraph>
            <input type="hidden" name="shopify_variant_id" value={variant.id} />
            <s-stack direction="inline" gap="small-200" align-items="center">
              <s-button type="button" onClick={pickVariant}>
                Choose Care product
              </s-button>
              <s-text>{variant.label}</s-text>
            </s-stack>
            <s-text-field
              label="Name"
              name="name"
              value={values.name}
              required
              details="Shown to customers on the product page and in emails."
            ></s-text-field>
            <s-grid grid-template-columns="1fr 1fr" gap="small-200">
              <s-number-field
                label="Cover length (months from purchase)"
                name="term_months"
                value={values.termMonths}
                min={1}
                max={120}
              ></s-number-field>
              <s-number-field
                label="Can be added up to (days after purchase)"
                name="offer_window_days"
                value={values.offerWindowDays}
                min={0}
                max={365}
                details="0 = only on the product page."
              ></s-number-field>
            </s-grid>
            <input type="hidden" name="active" value="0" />
            <s-checkbox name="active" value="1" label="Active (offered to customers)" {...checkedIf(values.active)}></s-checkbox>
          </s-stack>
        </s-section>

        <s-section heading="What it covers">
          <s-stack direction="block" gap="small-200">
            <s-paragraph color="subdued">
              Every repair to the customer&apos;s product for the length of the plan, apart from the exclusions below.
            </s-paragraph>
            <s-money-field
              label="Excess per repair"
              name="excess"
              value={values.excess}
              min={0}
              details="Optional, e.g. return postage. Charged on each repair the plan covers."
            ></s-money-field>
          </s-stack>
        </s-section>

        <s-section heading="Perks">
          <s-stack direction="block" gap="small-200">
            <input type="hidden" name="perks[priority]" value="0" />
            <s-checkbox name="perks[priority]" value="1" label="Priority turnaround" {...checkedIf(values.priority)}></s-checkbox>
            {tradeInEnabled ? (
              <s-number-field
                label="% extra trade-in credit"
                name="perks[trade_in_bonus_percent]"
                value={values.tradeInBonusPercent}
                min={0}
                max={100}
              ></s-number-field>
            ) : null}
          </s-stack>
        </s-section>

        <s-section heading="Which products">
          <s-stack direction="block" gap="small-200">
            <ProductGroupSelect label="Offered on" name="product_group_id" selected={values.productGroupId} groups={groups} />
            <s-number-field label="Order on the product page" name="position" value={values.position} min={0}></s-number-field>
          </s-stack>
        </s-section>

        <s-section heading="Exclusions">
          <s-stack direction="block" gap="small-200">
            <s-paragraph color="subdued">
              Every plan excludes: {standardExclusions}. Covering these would make the plan insurance, so they can&apos;t
              be switched on.
            </s-paragraph>
            <s-text-area
              label="Your extra exclusions"
              name="exclusions"
              rows={3}
              value={values.exclusions}
              details="One per line, e.g. “Wear to suede uppers”."
            ></s-text-area>
          </s-stack>
        </s-section>

        <s-section heading="Terms customers see">
          <s-stack direction="block" gap="small-200">
            <s-paragraph color="subdued">
              Generated from this plan and shown under “What&apos;s covered” on the product page. Save to update the
              preview. Add exclusions above; the fixed terms and the statutory rights sentence can&apos;t be removed.
            </s-paragraph>
            <s-unordered-list>
              {terms.map((line) => (
                <s-list-item key={line}>{line}</s-list-item>
              ))}
            </s-unordered-list>
          </s-stack>
        </s-section>

        <s-stack direction="inline">
          <s-button variant="primary" type="submit">
            Save Care plan
          </s-button>
        </s-stack>
      </s-stack>
    </Form>
  );
}

import { Form } from "react-router";
import { checkedIf, selectedIf } from "./attrs";
import { ErrorBanner } from "./error-banner";
import { ProductGroupSelect, type GroupOption } from "./product-group-select";

export interface PolicyFormValues {
  name: string;
  months: string;
  active: boolean;
  outcome: string;
  discountPercent: string;
  coveredFaults: string;
  productGroupId: number | null;
  position: string;
}

/** Rails warranty_policies/_form. */
export function WarrantyPolicyForm({
  values,
  groups,
  preview,
  errors,
}: {
  values: PolicyFormValues;
  groups: GroupOption[];
  preview: string[];
  errors?: string[];
}) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="save" />
      <s-stack direction="block" gap="base">
        <ErrorBanner errors={errors} />
        <s-section heading="Policy">
          <s-stack direction="block" gap="small-200">
            <s-text-field
              label="Name"
              name="name"
              value={values.name}
              required
              details="Shown to staff and customers, e.g. “2-year sole guarantee”."
            ></s-text-field>
            <s-number-field label="Cover length (months)" name="months" value={values.months} min={1} max={240}></s-number-field>
            <input type="hidden" name="active" value="0" />
            <s-checkbox name="active" value="1" label="Active" {...checkedIf(values.active)}></s-checkbox>
          </s-stack>
        </s-section>

        <s-section heading="What it gives">
          <s-stack direction="block" gap="small-200">
            <s-select label="Outcome" name="outcome">
              <s-option value="free" {...selectedIf(values.outcome === "free")}>
                Free repair
              </s-option>
              <s-option value="discount" {...selectedIf(values.outcome === "discount")}>
                Discounted repair
              </s-option>
            </s-select>
            <s-number-field
              label="Discount (%)"
              name="discount_percent"
              value={values.discountPercent}
              min={1}
              max={100}
              details="Only used for a discounted repair."
            ></s-number-field>
            <s-text-area
              label="Covered faults"
              name="covered_faults"
              rows={4}
              value={values.coveredFaults}
              details="One per line, e.g. “Sole separation”. Shown to staff on covered tickets."
            ></s-text-area>
          </s-stack>
        </s-section>

        <s-section heading="Which products">
          <s-stack direction="block" gap="small-200">
            <ProductGroupSelect label="Applies to" name="product_group_id" selected={values.productGroupId} groups={groups} />
            <s-number-field
              label="Priority"
              name="position"
              value={values.position}
              min={0}
              details="Lower numbers are checked first; the first matching policy wins."
            ></s-number-field>
          </s-stack>
        </s-section>

        <s-section heading="What customers see">
          <s-stack direction="block" gap="small-200">
            <s-paragraph color="subdued">Shown with the customer&apos;s cover. Save to update the preview.</s-paragraph>
            <s-unordered-list>
              {preview.map((line) => (
                <s-list-item key={line}>{line}</s-list-item>
              ))}
            </s-unordered-list>
          </s-stack>
        </s-section>

        <s-stack direction="inline" gap="small-200">
          <s-button variant="primary" type="submit">
            Save policy
          </s-button>
        </s-stack>
      </s-stack>
    </Form>
  );
}

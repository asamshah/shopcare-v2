import { Form } from "react-router";
import { checkedIf, selectedIf } from "./attrs";
import { ErrorBanner } from "./error-banner";

export interface ProgramFormValues {
  name: string;
  creditMode: string;
  maxAgeMonths: string;
  instructions: string;
  active: boolean;
  grades: { key: string; label: string; description: string; value: string }[];
  eligibilityMode: string;
  eligibilityValue: string;
  position: string;
}

const MODES: [string, string][] = [
  ["all", "All products"],
  ["tag", "Products with a tag"],
  ["collection", "Products in a collection"],
  ["product_type", "Products of a type"],
];

/** Rails trade_in_programs/_form. `rows` are the grades padded with blank rows. */
export function TradeInProgramForm({
  values,
  rows,
  errors,
}: {
  values: ProgramFormValues;
  rows: ProgramFormValues["grades"];
  errors?: string[];
}) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="save" />
      <s-stack direction="block" gap="base">
        <ErrorBanner errors={errors} />
        <s-section heading="Program">
          <s-stack direction="block" gap="small-200">
            <s-text-field label="Name" name="name" value={values.name} required></s-text-field>
            <s-select label="Credit is" name="credit_mode">
              <s-option value="fixed" {...selectedIf(values.creditMode === "fixed")}>
                A fixed amount per condition
              </s-option>
              <s-option value="percent" {...selectedIf(values.creditMode === "percent")}>
                A percentage of what the customer paid
              </s-option>
            </s-select>
            <s-number-field
              label="Only items bought in the last (months)"
              name="max_age_months"
              value={values.maxAgeMonths}
              min={1}
              details="Leave blank to take items of any age."
            ></s-number-field>
            <s-text-area
              label="What happens next (sent when you approve)"
              name="instructions"
              rows={3}
              value={values.instructions}
              details="E.g. how to post the item, or that they can drop it in store."
            ></s-text-area>
            <input type="hidden" name="active" value="0" />
            <s-checkbox name="active" value="1" label="Active" {...checkedIf(values.active)}></s-checkbox>
          </s-stack>
        </s-section>

        <s-section heading="Conditions">
          <s-stack direction="block" gap="small-200">
            <s-paragraph color="subdued">
              Customers pick the condition that matches their item. You check it when it arrives. Leave a row empty to
              remove it. Care plan holders get their plan&apos;s trade-in bonus on top.
            </s-paragraph>
            {rows.map((grade, index) => (
              <s-grid key={index} grid-template-columns="1fr 2fr 1fr" gap="small-200">
                <input type="hidden" name={`grades[${index}][key]`} value={grade.key} />
                <s-text-field label="Condition" name={`grades[${index}][label]`} value={grade.label}></s-text-field>
                <s-text-field label="Description" name={`grades[${index}][description]`} value={grade.description}></s-text-field>
                <s-number-field
                  label="Credit (amount or %)"
                  name={`grades[${index}][value]`}
                  value={grade.value}
                  min={0}
                  step={0.01}
                ></s-number-field>
              </s-grid>
            ))}
          </s-stack>
        </s-section>

        <s-section heading="Which products">
          <s-stack direction="block" gap="small-200">
            <s-select label="Takes" name="eligibility_mode">
              {MODES.map(([mode, label]) => (
                <s-option key={mode} value={mode} {...selectedIf(values.eligibilityMode === mode)}>
                  {label}
                </s-option>
              ))}
            </s-select>
            <s-text-field
              label="Tag, collection ID or product type"
              name="eligibility_value"
              value={values.eligibilityValue}
              details="A fixed-amount program for all products also takes things customers didn't buy from you."
            ></s-text-field>
            <s-number-field label="Priority" name="position" value={values.position} min={0}></s-number-field>
          </s-stack>
        </s-section>

        <s-stack direction="inline">
          <s-button variant="primary" type="submit">
            Save program
          </s-button>
        </s-stack>
      </s-stack>
    </Form>
  );
}

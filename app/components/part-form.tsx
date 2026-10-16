import { Form } from "react-router";
import { checkedIf, selectedIf } from "./attrs";
import { ErrorBanner } from "./error-banner";

export interface PartFormValues {
  name: string;
  sku: string;
  notes: string;
  active: boolean;
  unit: string;
  packSize: string;
  costPerUnit: string;
  reorderLevel: string;
  reorderQuantity: string;
  optionNames: string[];
}

/** Rails parts/_form. */
export function PartForm({
  values,
  units,
  options,
  errors,
}: {
  values: PartFormValues;
  units: { value: string; label: string }[];
  options: { value: string; label: string }[];
  errors?: string[];
}) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="save" />
      <s-stack direction="block" gap="base">
        <ErrorBanner errors={errors} />
        <s-section heading="Part">
          <s-stack direction="block" gap="small-200">
            <s-text-field label="Name" name="name" value={values.name} required placeholder="e.g. Commando outsole"></s-text-field>
            <s-text-field label="SKU" name="sku" value={values.sku}></s-text-field>
            <s-text-area
              label="Notes"
              name="notes"
              rows={2}
              value={values.notes}
              details="Supplier, compatibility (which ranges or models it fits)…"
            ></s-text-area>
            <input type="hidden" name="active" value="0" />
            <s-checkbox name="active" value="1" label="Active" {...checkedIf(values.active)}></s-checkbox>
          </s-stack>
        </s-section>

        <s-section heading="Units and cost">
          <s-stack direction="block" gap="small-200">
            <s-select label="Counted in" name="unit">
              {units.map((u) => (
                <s-option key={u.value} value={u.value} {...selectedIf(values.unit === u.value)}>
                  {u.label}
                </s-option>
              ))}
            </s-select>
            <s-grid grid-template-columns="1fr 1fr" gap="small-200">
              <s-number-field
                label="Units per pack"
                name="pack_size"
                value={values.packSize}
                min={0.001}
                step={0.001}
                details="How it's bought, e.g. eyelets in packs of 100."
              ></s-number-field>
              <s-number-field label="Cost per unit" name="cost_per_unit" value={values.costPerUnit} min={0} step={0.0001}></s-number-field>
            </s-grid>
            <s-grid grid-template-columns="1fr 1fr" gap="small-200">
              <s-number-field
                label="Reorder at"
                name="reorder_level"
                value={values.reorderLevel}
                min={0}
                step={0.001}
                details="Each variant is flagged low at or below this."
              ></s-number-field>
              <s-number-field
                label="Reorder quantity"
                name="reorder_quantity"
                value={values.reorderQuantity}
                min={0}
                step={0.001}
                details="Units to buy above the reorder level."
              ></s-number-field>
            </s-grid>
          </s-stack>
        </s-section>

        <s-section heading="Variants">
          <s-stack direction="block" gap="small-200">
            <s-paragraph color="subdued">
              Tick what varies. A sole that comes per model, size and colour needs all three; adhesive needs none.
            </s-paragraph>
            <input type="hidden" name="option_names" value="" />
            {options.map((o) => (
              <s-checkbox
                key={o.value}
                name="option_names"
                value={o.value}
                label={o.label}
                {...checkedIf(values.optionNames.includes(o.value))}
              ></s-checkbox>
            ))}
          </s-stack>
        </s-section>

        <s-stack direction="inline">
          <s-button variant="primary" type="submit">
            Save part
          </s-button>
        </s-stack>
      </s-stack>
    </Form>
  );
}

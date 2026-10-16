import { useState } from "react";
import { Form } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { selectedIf } from "./attrs";
import { ErrorBanner } from "./error-banner";
import { useElementValue } from "./use-element-value";

export interface GroupFormValues {
  name: string;
  rule: string;
  collections: { id: string; title: string }[];
  tags: string;
  productType: string;
}

const RULES: [string, string][] = [
  ["collections", "Products in any of these collections"],
  ["tags", "Products with any of these tags"],
  ["product_type", "Products of a type"],
  ["all", "All products"],
];

/** Rails product_groups/_form: only the chosen rule's fields show. */
export function ProductGroupForm({ values, errors }: { values: GroupFormValues; errors?: string[] }) {
  const shopify = useAppBridge();
  const [ruleRef, rule] = useElementValue<HTMLElementTagNameMap["s-select"]>(values.rule);
  const [collections, setCollections] = useState(values.collections);

  async function pickCollections() {
    const selection = await shopify.resourcePicker({
      type: "collection",
      action: "select",
      multiple: true,
      selectionIds: collections.map((c) => ({ id: c.id })),
    });
    if (!selection) return;
    setCollections((selection as { id: string; title: string }[]).map((c) => ({ id: c.id, title: c.title })));
  }

  return (
    <Form method="post">
      <input type="hidden" name="intent" value="save" />
      <s-stack direction="block" gap="base">
        <ErrorBanner errors={errors} />
        <s-section heading="Group">
          <s-stack direction="block" gap="small-200">
            <s-text-field
              label="Name"
              name="name"
              value={values.name}
              required
              placeholder="e.g. Leather boots"
              details="Only you see this. Warranty policies and Care plans choose a group by name."
            ></s-text-field>
            <s-select label="Products in this group" name="rule" ref={ruleRef}>
              {RULES.map(([value, label]) => (
                <s-option key={value} value={value} {...selectedIf(values.rule === value)}>
                  {label}
                </s-option>
              ))}
            </s-select>
            <div hidden={rule !== "collections"}>
              <input type="hidden" name="collections_json" value={JSON.stringify(collections)} />
              <s-stack direction="inline" gap="small-200" align-items="center">
                <s-button type="button" onClick={pickCollections}>
                  Choose collections
                </s-button>
                <s-text>{collections.length ? collections.map((c) => c.title).join(", ") : "No collections chosen"}</s-text>
              </s-stack>
            </div>
            <div hidden={rule !== "tags"}>
              <s-text-field
                label="Tags"
                name="tags"
                value={values.tags}
                placeholder="leather, boots"
                details="Separate tags with commas. A product with any of them is in the group."
              ></s-text-field>
            </div>
            <div hidden={rule !== "product_type"}>
              <s-text-field label="Product type" name="product_type" value={values.productType} placeholder="Boots"></s-text-field>
            </div>
          </s-stack>
        </s-section>
        <s-stack direction="inline">
          <s-button variant="primary" type="submit">
            Save group
          </s-button>
        </s-stack>
      </s-stack>
    </Form>
  );
}

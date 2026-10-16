import { Form, useSubmit } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { checkedIf } from "./attrs";
import { OrderConfirmationSnippet } from "./order-confirmation-snippet";
import { ProductGroupSelect, type GroupOption } from "./product-group-select";

export interface WizardData {
  step: number;
  groups: GroupOption[];
  groupNames: string;
  servicesCount: number;
  servicesLabel: string;
  policyNames: string;
  plansLabel: string | null;
  partsEnabled: boolean;
  presetMonths: number;
  /** One line, or null until Settings → Repairs has a complete workshop address. */
  workshopAddress: string | null;
  /** The Order confirmation snippet, on step 4. */
  snippet: string | null;
}

const STEPS: [number, string][] = [
  [1, "Product groups"],
  [2, "Repair services"],
  [3, "Warranty & Care"],
  [4, "Order confirmation (optional)"],
];

/** First-run setup on the admin home: four steps, each skippable (Rails setup/_wizard, plus v2's step 4). */
export function SetupWizard({ wizard }: { wizard: WizardData }) {
  const shopify = useAppBridge();
  const submit = useSubmit();
  const { step } = wizard;

  async function pickCollection() {
    const selection = await shopify.resourcePicker({ type: "collection", action: "select", multiple: false });
    if (!selection || !selection.length) return;
    const collection = selection[0] as { id: string; title: string };
    submit(
      { intent: "services", collection_id: collection.id.split("/").pop() ?? "", collection_title: collection.title },
      { method: "post", action: "/app/setup" },
    );
  }

  return (
    <s-section heading={`Set up ShopCare · Step ${step} of ${STEPS.length}`}>
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small-200">
          {STEPS.map(([number, label]) => (
            <s-link key={number} href={`/app/tickets?setup_step=${number}`}>
              <s-badge tone={number === step ? "info" : "neutral"}>
                {number}. {label}
              </s-badge>
            </s-link>
          ))}
        </s-stack>

        {step === 1 ? (
          <>
            <s-paragraph>
              Group the products that share the same cover, for example “Leather boots” (a collection) or “Sandals”
              (a product type). If warranty and Care apply to everything you sell, skip this step.
            </s-paragraph>
            {wizard.groups.length ? <s-text color="subdued">Your groups: {wizard.groupNames}.</s-text> : null}
            <s-stack direction="inline" gap="small-200">
              <s-button href="/app/product_groups/new">
                {wizard.groups.length ? "Add another group" : "Add a product group"}
              </s-button>
              <s-button variant="primary" href="/app/tickets?setup_step=2">
                {wizard.groups.length ? "Next" : "Skip this step"}
              </s-button>
            </s-stack>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <s-paragraph>
              Your repair services (e.g. “Full resole”) are Shopify products. Choose the collection they&apos;re in
              and we&apos;ll import them, or tag them “repair”.
            </s-paragraph>
            {wizard.servicesCount > 0 ? (
              <s-text color="subdued">
                {wizard.servicesLabel} imported. <s-link href="/app/repair_services">Review them</s-link>
              </s-text>
            ) : null}
            <Form method="post" action="/app/setup">
              <input type="hidden" name="intent" value="services" />
              <s-stack direction="inline" gap="small-200">
                <s-button type="button" onClick={pickCollection}>
                  Import from a collection
                </s-button>
                <s-button type="submit">Import products tagged “repair”</s-button>
                <s-button variant="primary" href="/app/tickets?setup_step=3">
                  {wizard.servicesCount > 0 ? "Next" : "Skip this step"}
                </s-button>
              </s-stack>
            </Form>
            {wizard.workshopAddress ? (
              <s-text color="subdued">
                Customers post their items to {wizard.workshopAddress}.{" "}
                <s-link href="/app/settings">Change</s-link>
              </s-text>
            ) : (
              <s-banner tone="warning">
                Where should customers post their items? <s-link href="/app/settings">Add your workshop address</s-link>{" "}
                in Settings → Repairs, so paid repairs come with a printable postage slip.
              </s-banner>
            )}
          </>
        ) : null}

        {step === 3 ? (
          <>
            <s-paragraph>
              Switch on a warranty for the products you sell, and optionally a paid Care plan customers can add on
              the product page.
            </s-paragraph>
            {wizard.policyNames ? (
              <s-text color="subdued">
                Warranty on: {wizard.policyNames}. <s-link href="/app/warranty_policies">Manage</s-link>
              </s-text>
            ) : (
              <Form method="post" action="/app/setup">
                <input type="hidden" name="intent" value="warranty" />
                <s-stack direction="block" gap="small-200">
                  <s-grid grid-template-columns="1fr 1fr" gap="small-200">
                    <s-number-field
                      label="Free repairs for (months)"
                      name="months"
                      value={String(wizard.presetMonths)}
                      min={1}
                      max={240}
                    ></s-number-field>
                    <div>
                      <ProductGroupSelect label="On" name="product_group_id" selected={null} groups={wizard.groups} />
                    </div>
                  </s-grid>
                  <s-stack direction="inline">
                    <s-button type="submit">Switch on warranty</s-button>
                  </s-stack>
                </s-stack>
              </Form>
            )}
            {wizard.plansLabel ? (
              <s-text color="subdued">
                {wizard.plansLabel} set up. <s-link href="/app/care_plans">Manage</s-link>
              </s-text>
            ) : (
              <s-paragraph color="subdued">
                Care: create a “2-year Care” product in Shopify (priced at what you&apos;ll charge), then{" "}
                <s-link href="/app/care_plans/new">add a starter Care plan</s-link>: 2 years, all repairs, no excess.
                You can do this later.
              </s-paragraph>
            )}
            <Form method="post" action="/app/setup">
              <input type="hidden" name="intent" value="parts" />
              <s-stack direction="block" gap="small-200">
                <input type="hidden" name="parts_enabled" value="0" />
                <s-checkbox
                  name="parts_enabled"
                  value="1"
                  label="Also track workshop inventory (optional)"
                  details="Parts and materials your workshop uses for repairs. Separate from your Shopify product inventory. You can switch this on later in Settings."
                  {...checkedIf(wizard.partsEnabled)}
                ></s-checkbox>
                <s-stack direction="inline">
                  <s-button variant="primary" type="submit">
                    Next
                  </s-button>
                </s-stack>
              </s-stack>
            </Form>
          </>
        ) : null}

        {step === 4 ? (
          <>
            <s-paragraph>
              Shopify sends all your emails, not ShopCare. Add ShopCare&apos;s section to Shopify&apos;s Order
              confirmation so repair customers get their postage slip and posting instructions, and Care buyers see
              what their plan covers. You can do this later in Settings → Emails.
            </s-paragraph>
            {wizard.snippet ? <OrderConfirmationSnippet snippet={wizard.snippet} /> : null}
            <Form method="post" action="/app/setup">
              <input type="hidden" name="intent" value="complete" />
              <s-stack direction="inline">
                <s-button variant="primary" type="submit">
                  Finish setup
                </s-button>
              </s-stack>
            </Form>
          </>
        ) : null}

        {step !== 4 ? (
          <Form method="post" action="/app/setup">
            <input type="hidden" name="intent" value="complete" />
            <input type="hidden" name="skipped" value="1" />
            <s-button variant="tertiary" type="submit">
              Skip setup
            </s-button>
          </Form>
        ) : null}
      </s-stack>
    </s-section>
  );
}

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import prisma from "../db.server";
import { checkedIf, selectedIf } from "../components/attrs";
import { useElementValue } from "../components/use-element-value";
import { formatShortDateTime, statusLabel } from "../lib/format";
import { RECENT_ORDER as DELIVERIES_ORDER } from "../models/notification-delivery.server";
import {
  careOfferDelayDays,
  careSettings,
  completeWorkshopAddress,
  DEFAULT_POSTING_INSTRUCTIONS,
  workshopAddress,
  notificationsSettings,
  partsEnabled,
  partsSettings,
  quoteValidDays,
  settingsOf,
  tradeInEnabled,
  tradeInSettings,
} from "../models/shop.server";
import { jsonObject } from "../models/validation.server";
import { requireAdmin } from "../services/admin/context.server";
import { redirectWithFlash } from "../services/admin/flash.server";
import { field, parse, readForm } from "../services/admin/form.server";
import { hasSecret, saveSettings, sendKlaviyoTest } from "../services/admin/settings.server";
import { EMAIL_KINDS } from "../services/notifications/events.server";
import { isEmailEnabled } from "../services/notifications/settings.server";

const EMAIL_LABELS: Record<(typeof EMAIL_KINDS)[number], [string, string]> = {
  repair_received: ["Repair request received", "To the customer when they submit a repair request."],
  repair_status_changed: ["Repair status changed", "To the customer when a repair is assessed, in repair, ready or returned."],
  send_item: [
    "Send your item to us",
    "To the customer once the quote is paid (or covered): the postage slip PDF attached, plus a download link.",
  ],
  item_received: ["We've received your item", "To the customer when you mark their parcel as received."],
  care_welcome: ["Care plan welcome", "To the customer when their Care plan starts."],
  care_credit_issued: ["Care credit code", "To the customer when a refunded item's Care becomes a credit code."],
  care_offer: ["Add Care to your purchase", "Marketing: only to customers subscribed to email marketing. Off until you switch it on."],
  staff_repair_request: ["New repair request", "Staff alert."],
  staff_quote_paid: ["Quote paid", "Staff alert."],
  staff_quote_declined: ["Quote declined", "Staff alert, with the customer's reason."],
  staff_quote_expired: ["Quote expired", "Staff alert."],
};

const CHANNEL_LABELS: Record<string, string> = {
  email: "Email",
  staff_email: "Staff email",
  flow: "Shopify Flow",
  klaviyo: "Klaviyo",
};

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));

// GET /app/settings (Rails SettingsController#show). Secrets are never sent to the browser.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const settings = settingsOf(shop);
  const rp = jsonObject(settings.repair_products as never);
  const email = jsonObject(settings.email as never);
  const notifications = notificationsSettings(shop);
  const emails = jsonObject(notifications.emails as never);
  const [planCount, deliveries] = await Promise.all([
    prisma.carePlan.count({ where: { shopId: shop.id } }),
    prisma.notificationDelivery.findMany({ where: { shopId: shop.id }, orderBy: DELIVERIES_ORDER, take: 15 }),
  ]);
  const enabled = (kind: (typeof EMAIL_KINDS)[number]) =>
    isEmailEnabled(
      { shopId: shop.shopifyDomain, shopName: "", flowEnabled: false, emails: { [kind]: jsonObject(emails[kind] as never) } },
      kind,
    );
  return {
    repairProducts: {
      mode: rp.mode === "collection" ? "collection" : "tag",
      tag: text(rp.tag),
      collectionId: text(rp.collection_id),
      collectionTitle: text(rp.collection_title),
    },
    repairOrderTag: text(settings.repair_order_tag),
    currency: text(settings.currency),
    quoteValidDays: quoteValidDays(shop),
    workshopAddress: workshopAddress(shop),
    workshopAddressComplete: completeWorkshopAddress(shop) !== null,
    postingInstructions: text(settings.posting_instructions),
    defaultPostingInstructions: DEFAULT_POSTING_INSTRUCTIONS,
    email: { subject: text(email.subject), body: text(email.body) },
    shopName: text(settings.shop_name) || "your store",
    partsEnabled: partsEnabled(shop),
    parts: Object.fromEntries(Object.entries(partsSettings(shop)).map(([k, v]) => [k, text(v)])),
    care: planCount > 0 ? Object.fromEntries(Object.entries(careSettings(shop)).map(([k, v]) => [k, text(v)])) : null,
    tradeIn: tradeInEnabled(shop)
      ? Object.fromEntries(Object.entries(tradeInSettings(shop)).map(([k, v]) => [k, text(v)]))
      : null,
    notifications: {
      flow: notifications.flow === true || notifications.flow === "true",
      staffEmail: text(notifications.staff_email),
      supportEmail: text(notifications.support_email),
      careOfferDelayDays: String(careOfferDelayDays(shop)),
      statusUrl: text(notifications.status_url),
      contactEmail: text(settings.contact_email),
      emails: EMAIL_KINDS.map((kind) => {
        const entry = jsonObject(emails[kind] as never);
        return {
          kind,
          label: EMAIL_LABELS[kind][0],
          details: EMAIL_LABELS[kind][1],
          enabled: enabled(kind),
          subject: text(entry.subject),
          intro: text(entry.intro),
        };
      }),
    },
    webhookUrl: text(settings.webhook_url),
    hasKlaviyoKey: hasSecret(shop, "klaviyoApiKey"),
    hasWebhookSecret: hasSecret(shop, "webhookSecret"),
    deliveries: deliveries.map((d) => ({
      id: d.id,
      when: formatShortDateTime(d.createdAt),
      event: statusLabel(d.event),
      channel: CHANNEL_LABELS[d.channel] ?? d.channel,
      status: d.status,
      statusLabel: statusLabel(d.status),
      tone: ({ sent: "success", failed: "critical", skipped: "neutral" } as const)[d.status as "sent"] ?? "info",
      error: d.error ?? "",
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const form = await readForm(request);
  const intent = parse(z.enum(["save", "klaviyo_test"]).catch("save"), field(form, "intent"));
  if (intent === "klaviyo_test") {
    return redirectWithFlash("/app/settings", await sendKlaviyoTest(shop, field(form, "email")));
  }
  const result = await saveSettings(shop, form);
  return redirectWithFlash("/app/settings", result.ok ? { notice: "Settings saved." } : { alert: result.alert });
};

export default function Settings() {
  const d = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const [modeRef, mode] = useElementValue<HTMLElementTagNameMap["s-select"]>(d.repairProducts.mode);
  const [collection, setCollection] = useState({ id: d.repairProducts.collectionId, title: d.repairProducts.collectionTitle });

  async function pickCollection() {
    const selection = await shopify.resourcePicker({
      type: "collection",
      action: "select",
      multiple: false,
      selectionIds: collection.id ? [{ id: `gid://shopify/Collection/${collection.id}` }] : [],
    });
    if (!selection || !selection.length) return;
    const chosen = selection[0] as { id: string; title: string };
    setCollection({ id: chosen.id.split("/").pop() ?? "", title: chosen.title });
  }

  return (
    <s-page heading="Settings">
      <Form method="post">
        <input type="hidden" name="intent" value="save" />
        <s-stack direction="block" gap="base">
          <s-section heading="Repairs">
            <s-stack direction="block" gap="small-200">
              <s-paragraph color="subdued">
                Set up your repair services as normal Shopify products, then tell us where to find them. They appear in
                the quotation builder&apos;s product picker.
              </s-paragraph>
              <s-select label="Repair products" name="repair_products[mode]" ref={modeRef}>
                <s-option value="tag" {...selectedIf(d.repairProducts.mode !== "collection")}>
                  Products with a tag
                </s-option>
                <s-option value="collection" {...selectedIf(d.repairProducts.mode === "collection")}>
                  Products in a collection
                </s-option>
              </s-select>
              <div hidden={mode === "collection"}>
                <s-text-field
                  label="Product tag"
                  name="repair_products[tag]"
                  value={d.repairProducts.tag}
                  placeholder="repair"
                  details="Leave blank to use “repair”."
                ></s-text-field>
              </div>
              <div hidden={mode !== "collection"}>
                <input type="hidden" name="repair_products[collection_id]" value={collection.id} />
                <input type="hidden" name="repair_products[collection_title]" value={collection.title} />
                <s-stack direction="inline" gap="small-200" align-items="center">
                  <s-button type="button" onClick={pickCollection}>
                    Choose collection
                  </s-button>
                  <s-text>
                    {collection.id ? collection.title || `Collection ${collection.id}` : "No collection chosen"}
                  </s-text>
                </s-stack>
              </div>
              <s-grid grid-template-columns="1fr 1fr" gap="small-200">
                <s-text-field
                  label="Order tag"
                  name="repair_order_tag"
                  value={d.repairOrderTag}
                  placeholder="repair"
                  details="Added to repair orders so ShopCare can tell them from ordinary sales."
                ></s-text-field>
                <s-text-field
                  label="Currency"
                  name="currency"
                  value={d.currency}
                  placeholder="GBP"
                  details="Used on quotes. Leave blank for GBP."
                ></s-text-field>
                <s-number-field
                  label="Quotes valid for (days)"
                  name="quote_valid_days"
                  value={String(d.quoteValidDays)}
                  min={1}
                  max={90}
                  details="How long a customer has to pay (accept) a quote's invoice before it expires and stops working."
                ></s-number-field>
              </s-grid>

              <s-heading>Workshop address</s-heading>
              <s-paragraph color="subdued">
                Where customers post their items. Once a quote is paid (or covered), ShopCare emails the customer a
                postage slip to print: an address label for the parcel and a packing slip to put inside. Customers pay
                their own postage.
              </s-paragraph>
              {d.workshopAddressComplete ? null : (
                <s-banner tone="warning">
                  Add the workshop&apos;s name, address, town, postcode and country. Until then no postage slips are
                  sent.
                </s-banner>
              )}
              <s-grid grid-template-columns="1fr 1fr" gap="small-200">
                <s-text-field
                  label="Name"
                  name="workshop_address[name]"
                  value={d.workshopAddress.name}
                  placeholder="Acme Repairs"
                  details="The first line of the label, e.g. your workshop or company name."
                ></s-text-field>
                <s-text-field
                  label="Country"
                  name="workshop_address[country]"
                  value={d.workshopAddress.country}
                  placeholder="United Kingdom"
                ></s-text-field>
                <s-text-field label="Address" name="workshop_address[line1]" value={d.workshopAddress.line1}></s-text-field>
                <s-text-field
                  label="Address line 2 (optional)"
                  name="workshop_address[line2]"
                  value={d.workshopAddress.line2}
                ></s-text-field>
                <s-text-field label="Town or city" name="workshop_address[city]" value={d.workshopAddress.city}></s-text-field>
                <s-text-field label="Postcode" name="workshop_address[postcode]" value={d.workshopAddress.postcode}></s-text-field>
              </s-grid>
              <s-text-area
                label="Posting instructions"
                name="posting_instructions"
                rows={3}
                value={d.postingInstructions}
                placeholder={d.defaultPostingInstructions}
                details="Printed on the postage slip and in the email. Leave blank to use ours."
              ></s-text-area>
            </s-stack>
          </s-section>

          <s-section heading="Workshop inventory">
            <s-stack direction="block" gap="small-200">
              <input type="hidden" name="parts_enabled" value="0" />
              <s-switch
                name="parts_enabled"
                value="1"
                label="Track workshop inventory"
                details="Parts and materials your workshop uses for repairs. Separate from your Shopify product inventory."
                {...checkedIf(d.partsEnabled)}
              ></s-switch>
              {d.partsEnabled ? (
                <>
                  <s-paragraph color="subdued">
                    How ShopCare reads an item&apos;s size, colour and model to pick the right part variants, and what
                    an hour of workshop time costs (used for each repair&apos;s margin).
                  </s-paragraph>
                  <s-grid grid-template-columns="1fr 1fr" gap="small-200">
                    <s-money-field label="Labour rate (per hour)" name="parts[labour_rate]" value={d.parts.labour_rate} min={0}></s-money-field>
                    <s-text-field
                      label="Model metafield"
                      name="parts[model_metafield]"
                      value={d.parts.model_metafield}
                      placeholder="custom.model"
                      details="namespace.key of a product metafield naming the model a part must fit. Optional."
                    ></s-text-field>
                    <s-text-field
                      label="Size option name"
                      name="parts[size_option]"
                      value={d.parts.size_option}
                      details="The variant option that holds the size. Separate alternatives with commas."
                    ></s-text-field>
                    <s-text-field label="Colour option name" name="parts[colour_option]" value={d.parts.colour_option}></s-text-field>
                  </s-grid>
                </>
              ) : null}
            </s-stack>
          </s-section>

          {d.care ? (
            <s-section heading="Care">
              <s-stack direction="block" gap="small-200">
                <s-select label="When an item with Care is refunded" name="care[refund_action]">
                  <s-option value="refund" {...selectedIf(d.care.refund_action === "refund")}>
                    Refund the Care plan too
                  </s-option>
                  <s-option value="credit" {...selectedIf(d.care.refund_action === "credit")}>
                    Give a credit code for the Care plan&apos;s value
                  </s-option>
                  <s-option value="manual" {...selectedIf(d.care.refund_action === "manual")}>
                    Do nothing; I&apos;ll decide
                  </s-option>
                </s-select>
                <s-grid grid-template-columns="1fr 1fr" gap="small-200">
                  <s-select label="Credit code can be spent on" name="care[credit_scope]">
                    <s-option value="care" {...selectedIf(d.care.credit_scope === "care")}>
                      Care plans (move Care to another product, or upgrade)
                    </s-option>
                    <s-option value="store" {...selectedIf(d.care.credit_scope === "store")}>
                      Anything in the store
                    </s-option>
                  </s-select>
                  <s-number-field
                    label="Credit code valid for (days)"
                    name="care[credit_days]"
                    value={d.care.credit_days}
                    min={0}
                    max={365}
                    details="Only for credit codes. 0 = no expiry."
                  ></s-number-field>
                </s-grid>
                <s-text-field
                  label="“Add Care” page URL"
                  name="care[add_later_url]"
                  value={d.care.add_later_url}
                  placeholder="https://yourstore.com/pages/care"
                  details="The page with the “Add Care to a purchase” block. Sent in Care offer emails."
                ></s-text-field>
              </s-stack>
            </s-section>
          ) : null}

          {d.tradeIn ? (
            <s-section heading="Trade-in">
              <s-grid grid-template-columns="1fr 1fr" gap="small-200">
                <s-select label="Pay trade-in credit as" name="trade_in[credit_method]">
                  <s-option value="store_credit" {...selectedIf(d.tradeIn.credit_method === "store_credit")}>
                    Store credit on the customer&apos;s account
                  </s-option>
                  <s-option value="discount_code" {...selectedIf(d.tradeIn.credit_method === "discount_code")}>
                    A single-use discount code
                  </s-option>
                </s-select>
                <s-number-field
                  label="Credit expires after (days)"
                  name="trade_in[credit_days]"
                  value={d.tradeIn.credit_days}
                  min={0}
                  max={3650}
                  details="0 = never. Guests always get a discount code."
                ></s-number-field>
              </s-grid>
            </s-section>
          ) : null}

          <s-section heading="Notifications">
            <s-stack direction="block" gap="base">
              <s-stack direction="block" gap="small-200">
                <s-paragraph color="subdued">
                  Send quote has Shopify email the customer the quote as an invoice, from your store: paying it accepts
                  the quote. ShopCare adds how long it&apos;s valid and a link to decline after your message.
                </s-paragraph>
                <s-text-field
                  label="Quote email subject"
                  name="email[subject]"
                  value={d.email.subject}
                  placeholder={`Your repair quote from ${d.shopName}`}
                ></s-text-field>
                <s-text-area
                  label="Quote email message"
                  name="email[body]"
                  rows={3}
                  value={d.email.body}
                  placeholder="Here's the quote for your repair."
                ></s-text-area>
              </s-stack>

              <s-stack direction="block" gap="small-200">
                <s-heading>ShopCare emails</s-heading>
                <s-paragraph color="subdued">
                  ShopCare emails your customers and staff from your store&apos;s name. Switch off any email your email
                  tool already sends. Leave a subject or intro blank to use ours; {"{{first_name}}"}, {"{{product}}"} and
                  {" {{ticket_number}}"} are filled in.
                </s-paragraph>
                <s-grid grid-template-columns="1fr 1fr" gap="small-200">
                  <s-email-field
                    label="Notify staff at"
                    name="notifications[staff_email]"
                    value={d.notifications.staffEmail}
                    placeholder="workshop@yourstore.com"
                    details="Where staff alerts go (new repair requests, quotes paid, declined or expired)."
                  ></s-email-field>
                  <s-email-field
                    label="Reply-to address"
                    name="notifications[support_email]"
                    value={d.notifications.supportEmail}
                    placeholder={d.notifications.contactEmail || "support@yourstore.com"}
                    details="Customers' replies go here. Leave blank to use your store's contact email."
                  ></s-email-field>
                  <s-url-field
                    label="Repair status page"
                    name="notifications[status_url]"
                    value={d.notifications.statusUrl}
                    placeholder="https://yourstore.com/pages/repair-status"
                    details="The page with the Repair status block. Customers' repair emails link to it."
                  ></s-url-field>
                  <s-number-field
                    label="Send the Add Care offer after (days)"
                    name="notifications[care_offer_delay_days]"
                    value={d.notifications.careOfferDelayDays}
                    min={1}
                    max={365}
                    step={1}
                    details="Days after purchase that customers who bought something Care could cover get the offer."
                  ></s-number-field>
                </s-grid>
                {d.notifications.emails.map((e) => (
                  <s-box key={e.kind} padding="small-200" border="base" border-radius="base">
                    <s-stack direction="block" gap="small-200">
                      <input type="hidden" name={`notifications[emails][${e.kind}][enabled]`} value="0" />
                      <s-checkbox
                        name={`notifications[emails][${e.kind}][enabled]`}
                        value="1"
                        label={e.label}
                        details={e.details}
                        {...checkedIf(e.enabled)}
                      ></s-checkbox>
                      <s-text-field
                        label="Subject"
                        name={`notifications[emails][${e.kind}][subject]`}
                        value={e.subject}
                      ></s-text-field>
                      <s-text-area
                        label="Intro"
                        name={`notifications[emails][${e.kind}][intro]`}
                        rows={2}
                        value={e.intro}
                      ></s-text-area>
                    </s-stack>
                  </s-box>
                ))}
              </s-stack>
            </s-stack>
          </s-section>

          <s-section heading="Advanced">
            <details className="settings-advanced">
              <summary style={{ cursor: "pointer", marginBottom: "1rem" }}>
                Integrations and Shopify Flow. Most shops don&apos;t need to change these.
              </summary>
              <s-stack direction="block" gap="base">
                <s-stack direction="block" gap="small-200">
                  <s-heading>Shopify Flow and Klaviyo</s-heading>
                  <s-paragraph color="subdued">
                    Optional: ShopCare can also tell Shopify Flow or Klaviyo what happened (Care bought, Care offer,
                    credit code, repair status, quotes paid / declined / expired), to build your own automations on.
                  </s-paragraph>
                  <input type="hidden" name="notifications[flow]" value="0" />
                  <s-checkbox
                    name="notifications[flow]"
                    value="1"
                    label="Shopify Flow and Shopify Email"
                    details="In Shopify Flow or Marketing → Automations, start a workflow from a ShopCare trigger and add a “Send marketing email” step."
                    {...checkedIf(d.notifications.flow)}
                  ></s-checkbox>
                  <s-password-field
                    label="Klaviyo private API key"
                    name="klaviyo_api_key"
                    placeholder={d.hasKlaviyoKey ? "•••••••• (saved — leave blank to keep)" : "pk_…"}
                    details="Needs the Events: write scope. Each event becomes a Klaviyo metric (e.g. “ShopCare Care Offer”) to build flows on."
                  ></s-password-field>
                  {d.hasKlaviyoKey ? <s-checkbox name="klaviyo_remove" value="1" label="Disconnect Klaviyo"></s-checkbox> : null}
                </s-stack>
                <s-stack direction="block" gap="small-200">
                  <s-heading>Outbound webhook</s-heading>
                  <s-paragraph color="subdued">
                    Send a JSON webhook to your automation tool (Zapier, Make, n8n…) whenever a repair is submitted, its
                    status changes, a quote is sent or declined, or it&apos;s paid.
                  </s-paragraph>
                  <s-url-field
                    label="Webhook URL"
                    name="webhook_url"
                    value={d.webhookUrl}
                    placeholder="https://hooks.example.com/repairs"
                  ></s-url-field>
                  <s-password-field
                    label="Signing secret"
                    name="webhook_secret"
                    placeholder={d.hasWebhookSecret ? "•••••••• (saved — leave blank to keep)" : ""}
                    details="Optional. If set, requests carry an X-ShopCare-Hmac-Sha256 signature."
                  ></s-password-field>
                </s-stack>
              </s-stack>
            </details>
          </s-section>

          <s-stack direction="inline">
            <s-button variant="primary" type="submit">
              Save settings
            </s-button>
          </s-stack>
        </s-stack>
      </Form>

      <s-section heading="Recent notifications">
        <s-stack direction="block" gap="base">
          {d.hasKlaviyoKey ? (
            <Form method="post">
              <input type="hidden" name="intent" value="klaviyo_test" />
              <s-stack direction="inline" gap="small-200" align-items="end">
                <s-email-field label="Send a Klaviyo test event to" name="email" placeholder="you@yourstore.com"></s-email-field>
                <s-button type="submit">Send test</s-button>
              </s-stack>
            </Form>
          ) : null}
          {d.deliveries.length ? (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header list-slot="secondary">When</s-table-header>
                <s-table-header list-slot="primary">Event</s-table-header>
                <s-table-header>Channel</s-table-header>
                <s-table-header list-slot="inline">Status</s-table-header>
                <s-table-header>Detail</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {d.deliveries.map((delivery) => (
                  <s-table-row key={delivery.id}>
                    <s-table-cell>{delivery.when}</s-table-cell>
                    <s-table-cell>{delivery.event}</s-table-cell>
                    <s-table-cell>{delivery.channel}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={delivery.tone}>{delivery.statusLabel}</s-badge>
                    </s-table-cell>
                    <s-table-cell>{delivery.error}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          ) : (
            <s-paragraph color="subdued">Nothing sent yet.</s-paragraph>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

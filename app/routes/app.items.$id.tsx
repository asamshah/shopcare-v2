import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { Cover, Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../db.server";
import { longDate } from "../lib/dates";
import {
  capitalize,
  formatDate,
  itemStatusTone,
  registrationTone,
  statusLabel,
  ticketStatusTone,
  truncate,
  type Tone,
} from "../lib/format";
import { formatMoney } from "../lib/format.server";
import { signedUrl } from "../lib/storage.server";
import { claimsCount, coveredFaults, coverName, coverOutcomeLabel } from "../models/cover.server";
import { COVERS_ORDER } from "../models/item.server";
import { rejectRegistration, verifyRegistration } from "../models/registration.server";
import { RECENT_ORDER as TICKETS_ORDER } from "../models/repair-ticket.server";
import { jsonObject } from "../models/validation.server";
import { orNotFound, parseId, requireAdmin } from "../services/admin/context.server";
import { redirectWithFlash } from "../services/admin/flash.server";
import { field, parse, readForm, zText } from "../services/admin/form.server";
import { shopCurrency } from "../services/admin/tickets.server";

/** [tone, label] for a cover's state today (Rails ItemsHelper#cover_state). */
function coverState(cover: Cover, now: Date): [Tone, string] {
  if (cover.status === "cancelled") return ["neutral", "Cancelled"];
  if (cover.endsAt <= now) return ["neutral", "Expired"];
  if (cover.startsAt > now) return ["info", `Starts ${longDate(cover.startsAt)}`];
  return ["success", "Active"];
}

const REFUND_ACTIONS: Record<string, string> = {
  refund: "Care plan refunded",
  refunded_by_merchant: "Care plan refunded with the item",
  manual: "Care plan left for you to refund or credit",
};

// GET /app/items/:id (Rails ItemsController#show).
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const item = orNotFound(
    await prisma.item.findFirst({
      where: { id: parseId(params.id), shopId: shop.id },
      include: {
        covers: { orderBy: COVERS_ORDER, include: { careCredits: true } },
        registration: true,
        repairTickets: { orderBy: TICKETS_ORDER },
      },
    }),
  );
  const now = new Date();
  const currency = shopCurrency(shop);
  const r = item.registration;
  return {
    item: {
      id: item.id,
      status: capitalize(item.status),
      statusTone: itemStatusTone(item.status),
      productTitle: item.productTitle ?? "",
      variantTitle: item.variantTitle && item.variantTitle !== "Default Title" ? item.variantTitle : null,
      sku: item.sku,
      orderName: item.orderName,
      purchased: formatDate(item.purchasedAt),
      customerName: item.customerName ?? "",
      customerEmail: item.customerEmail,
    },
    covers: item.covers.map((cover) => {
      const [tone, state] = coverState(cover, now);
      const refund = jsonObject(jsonObject(cover.usage).refund as Prisma.JsonValue);
      const action = String(refund.action ?? "");
      return {
        id: cover.id,
        name: coverName(cover),
        tone,
        state,
        kind: capitalize(cover.kind),
        summary: `${coverOutcomeLabel(cover)} · ${formatDate(cover.startsAt)} to ${formatDate(cover.endsAt)}`,
        faults: coveredFaults(cover),
        claims: claimsCount(cover),
        bought:
          cover.kind === "care" && cover.pricePaid
            ? `Bought for ${formatMoney(cover.pricePaid, currency)}${cover.shopifyOrderId ? ` on order #${cover.shopifyOrderId}` : ""}`
            : null,
        refund: refund.action
          ? {
              failed: refund.status === "failed",
              text: `Item refunded: ${action === "credit" ? `credit code ${String(refund.code ?? "")} issued` : REFUND_ACTIONS[action] ?? action}${
                refund.status === "failed" ? ` (failed: ${String(refund.error ?? "")})` : ""
              }`,
            }
          : null,
        // ShopCare doesn't email credit codes: staff share it; the customer also sees it on the Repair status page.
        credit: cover.careCredits[0]
          ? {
              code: cover.careCredits[0].code,
              text: `Care credit code ${cover.careCredits[0].code} for ${formatMoney(cover.careCredits[0].amount, currency)}${
                cover.careCredits[0].expiresAt ? `, use by ${formatDate(cover.careCredits[0].expiresAt)}` : ""
              }. Give it to the customer; it also shows on their Repair status page when they log in.`,
            }
          : null,
      };
    }),
    tickets: item.repairTickets.map((t) => ({
      id: t.id,
      issue: truncate(t.description, 80),
      status: statusLabel(t.status),
      tone: ticketStatusTone(t.status),
      date: formatDate(t.createdAt),
    })),
    registration: r
      ? {
          id: r.id,
          status: r.status,
          tone: registrationTone(r.status),
          retailer: r.retailer?.trim() || "not given",
          registered: formatDate(r.createdAt),
          proof: r.proofKey ? { url: signedUrl(r.proofKey), filename: r.proofFilename ?? "proof" } : null,
          reviewed: r.reviewedAt
            ? `${capitalize(r.status)} ${formatDate(r.reviewedAt)}${r.reviewNote?.trim() ? `: ${r.reviewNote}` : ""}`
            : null,
          unverified: r.status === "unverified",
        }
      : null,
  };
};

// Staff review of a registration: verify, or reject (voids the item, cancels its cover).
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const item = orNotFound(
    await prisma.item.findFirst({ where: { id: parseId(params.id), shopId: shop.id }, include: { registration: true } }),
  );
  const registration = orNotFound(item.registration);
  const form = await readForm(request);
  const intent = parse(z.enum(["verify", "reject"]), field(form, "intent"));
  const note = parse(zText(1000), field(form, "note")) || null;
  if (intent === "verify") {
    await verifyRegistration(registration.id, { note });
    return redirectWithFlash(`/app/items/${item.id}`, { notice: "Registration verified." });
  }
  await rejectRegistration(registration.id, { note });
  return redirectWithFlash(`/app/items/${item.id}`, { notice: "Registration rejected and cover cancelled." });
};

export default function Item() {
  const d = useLoaderData<typeof loader>();
  const { item, registration } = d;
  return (
    <s-page heading={`Item #${item.id}`}>
      <s-link slot="breadcrumb-actions" href="/app/items">
        Items
      </s-link>
      <s-badge slot="accessory" tone={item.statusTone}>
        {item.status}
      </s-badge>
      {registration ? (
        <s-badge slot="accessory" tone={registration.tone}>
          Registration {registration.status}
        </s-badge>
      ) : null}

      <s-grid grid-template-columns="2fr 1fr" gap="base">
        <s-stack direction="block" gap="base">
          <s-section heading="Cover">
            {d.covers.length ? (
              <s-stack direction="block" gap="small-200">
                {d.covers.map((cover) => (
                  <s-box key={cover.id} padding="small-200" border="base" border-radius="base">
                    <s-stack direction="block" gap="small-500">
                      <s-stack direction="inline" gap="small-200" align-items="center">
                        <s-text type="strong">{cover.name}</s-text>
                        <s-badge tone={cover.tone}>{cover.state}</s-badge>
                        <s-badge tone="neutral">{cover.kind}</s-badge>
                      </s-stack>
                      <s-text>{cover.summary}</s-text>
                      {cover.faults.length ? <s-text color="subdued">Covers: {cover.faults.join(", ")}</s-text> : null}
                      <s-text color="subdued">Claims so far: {cover.claims}</s-text>
                      {cover.bought ? <s-text color="subdued">{cover.bought}</s-text> : null}
                      {cover.refund ? (
                        cover.refund.failed ? (
                          <s-text tone="critical">{cover.refund.text}</s-text>
                        ) : (
                          <s-text color="subdued">{cover.refund.text}</s-text>
                        )
                      ) : null}
                      {cover.credit ? (
                        <s-banner tone="info" heading={`Credit code: ${cover.credit.code}`}>
                          {cover.credit.text}
                        </s-banner>
                      ) : null}
                    </s-stack>
                  </s-box>
                ))}
              </s-stack>
            ) : (
              <s-paragraph color="subdued">
                No cover. Either no <s-link href="/app/warranty_policies">warranty policy</s-link> matched this product
                when it was bought, or none was set up yet.
              </s-paragraph>
            )}
          </s-section>

          <s-section heading="Repairs">
            {d.tickets.length ? (
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header list-slot="kicker">Ticket</s-table-header>
                  <s-table-header list-slot="primary">Issue</s-table-header>
                  <s-table-header list-slot="inline">Status</s-table-header>
                  <s-table-header list-slot="secondary">Date</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {d.tickets.map((t) => (
                    <s-table-row key={t.id}>
                      <s-table-cell>
                        <s-link href={`/app/tickets/${t.id}`}>#{t.id}</s-link>
                      </s-table-cell>
                      <s-table-cell>{t.issue}</s-table-cell>
                      <s-table-cell>
                        <s-badge tone={t.tone}>{t.status}</s-badge>
                      </s-table-cell>
                      <s-table-cell>{t.date}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            ) : (
              <s-paragraph color="subdued">No repairs for this item yet.</s-paragraph>
            )}
          </s-section>

          {registration ? (
            <s-section heading="Registration">
              <s-stack direction="block" gap="small-200">
                <s-text>Bought from: {registration.retailer}</s-text>
                <s-text>Registered: {registration.registered}</s-text>
                {registration.proof ? (
                  <s-link href={registration.proof.url} target="_blank">
                    View proof of purchase ({registration.proof.filename})
                  </s-link>
                ) : (
                  <s-badge tone="caution">No proof of purchase uploaded</s-badge>
                )}
                {registration.reviewed ? <s-text color="subdued">{registration.reviewed}</s-text> : null}
                {registration.unverified ? (
                  <>
                    <s-divider></s-divider>
                    <s-grid grid-template-columns="1fr 1fr" gap="base">
                      <Form method="post">
                        <input type="hidden" name="intent" value="verify" />
                        <s-stack direction="block" gap="small-200">
                          <s-text-field label="Note (optional)" name="note" placeholder="e.g. Receipt checked"></s-text-field>
                          <s-stack direction="inline">
                            <s-button variant="primary" type="submit">
                              Verify
                            </s-button>
                          </s-stack>
                        </s-stack>
                      </Form>
                      <Form method="post">
                        <input type="hidden" name="intent" value="reject" />
                        <s-stack direction="block" gap="small-200">
                          <s-text-field
                            label="Reason (optional)"
                            name="note"
                            placeholder="e.g. Receipt doesn't match"
                          ></s-text-field>
                          <s-stack direction="inline">
                            <s-button tone="critical" type="submit">
                              Reject and cancel cover
                            </s-button>
                          </s-stack>
                        </s-stack>
                      </Form>
                    </s-grid>
                  </>
                ) : null}
              </s-stack>
            </s-section>
          ) : null}
        </s-stack>

        <s-stack direction="block" gap="base">
          <s-section heading="Product">
            <s-stack direction="block" gap="small-500">
              <s-text type="strong">{item.productTitle}</s-text>
              {item.variantTitle ? <s-text color="subdued">{item.variantTitle}</s-text> : null}
              {item.sku ? <s-text color="subdued">SKU {item.sku}</s-text> : null}
              {item.orderName ? <s-text color="subdued">Order {item.orderName}</s-text> : null}
              <s-text color="subdued">Purchased {item.purchased}</s-text>
            </s-stack>
          </s-section>
          <s-section heading="Customer">
            <s-stack direction="block" gap="small-500">
              <s-text type="strong">{item.customerName}</s-text>
              {item.customerEmail ? <s-text>{item.customerEmail}</s-text> : null}
            </s-stack>
          </s-section>
        </s-stack>
      </s-grid>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

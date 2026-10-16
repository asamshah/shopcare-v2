/**
 * The storefront quote review page (Rails app/views/proxy/quotes/show.html.erb),
 * rendered by Shopify as Liquid inside the merchant's theme. Every dynamic
 * value goes through liquidText, which escapes HTML and Liquid braces. No
 * colours: the page inherits the theme's (rules mixed from currentColor, the
 * theme's own button classes), with logical properties for RTL.
 */
import type { Cover, Quotation, QuotationLineItem, RepairTicket } from "@prisma/client";
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import { liquidText } from "../../lib/http.server";
import { lineTotal } from "../../models/quotation-line-item.server";
import {
  coverSummary,
  formattedAmount,
  formattedSubtotal,
  validUntil,
} from "../../models/quotation.server";
import { coverName } from "../../models/cover.server";
import { d } from "../../models/validation.server";

export type QuoteForPage = Quotation & {
  repairTicket: RepairTicket;
  cover: Cover | null;
  lineItems: QuotationLineItem[];
};

/** The quotation with what the page shows (lines in creation order). */
export function loadQuoteForPage(quotationId: number, db: Db = prisma): Promise<QuoteForPage | null> {
  return db.quotation.findUnique({
    where: { id: quotationId },
    include: {
      repairTicket: true,
      cover: true,
      lineItems: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    },
  });
}

const STYLE = `<style>
  .shopcare-quote { max-width: 42rem; margin-block: 2rem; margin-inline: auto; }
  .shopcare-quote table { width: 100%; border-collapse: collapse; margin-block: 1rem; }
  .shopcare-quote th, .shopcare-quote td { padding-block: 0.5rem; text-align: start; border-block-end: 1px solid; border-color: color-mix(in srgb, currentColor 25%, transparent); }
  .shopcare-quote .shopcare-quote__amount { text-align: end; }
  .shopcare-quote .shopcare-quote__actions { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-start; margin-block-start: 1.5rem; }
  .shopcare-quote textarea { display: block; box-sizing: border-box; width: 100%; margin-block: 0.5rem; padding: 0.5em 0.75em; font: inherit; color: inherit; background: transparent; border: 1px solid; border-color: color-mix(in srgb, currentColor 45%, transparent); border-radius: var(--inputs-radius, 0); }
  .shopcare-quote__notice { padding: 0.75rem 1rem; border: 1px solid; border-color: color-mix(in srgb, currentColor 25%, transparent); background: color-mix(in srgb, currentColor 6%, transparent); }
  .shopcare-quote__notice--error { border-color: currentColor; border-inline-start-width: 4px; background: transparent; color: var(--shopcare-error, color-mix(in srgb, #d72c0d 70%, currentColor)); }
</style>`;

export function renderQuotePage({
  quotation,
  error = null,
  actionBase,
  choice = null,
}: {
  quotation: QuoteForPage | null;
  error?: string | null;
  actionBase: string;
  choice?: string | null;
}): string {
  const t = liquidText;
  if (!quotation) {
    return `${STYLE}
<div class="page-width shopcare-quote">
    <h1>Quote not found</h1>
    <p>This link isn't valid any more. If you were expecting a repair quote, please contact us.</p>
</div>
`;
  }
  const ticket = quotation.repairTicket;
  const until = t(validUntil(quotation) ?? "");
  const status = {
    sent: `<p>This quote is valid until <strong>${until}</strong>. Pay to accept and we'll start your repair.</p>`,
    paid: `<p class="shopcare-quote__notice">Paid, thank you. We've started your repair.</p>`,
    declined: `<p class="shopcare-quote__notice">You declined this quote. Contact us if you change your mind.</p>`,
    expired: `<p class="shopcare-quote__notice">This quote expired on ${until}. Contact us if you'd still like the repair.</p>`,
  }[quotation.status] ?? `<p class="shopcare-quote__notice">This quote is no longer available.</p>`;

  const rows = quotation.lineItems.map(
    (line) => `
          <tr>
            <td>${t(line.title)}</td>
            <td>${line.quantity}</td>
            <td class="shopcare-quote__amount">${t(formattedAmount(quotation, lineTotal(line)))}</td>
          </tr>`,
  );
  if (d(quotation.coverDiscount).gt(0)) {
    rows.push(`
          <tr>
            <td colspan="2">${t(quotation.cover ? coverName(quotation.cover) : "Cover")}</td>
            <td class="shopcare-quote__amount">−${t(formattedAmount(quotation, quotation.coverDiscount))}</td>
          </tr>`);
  }
  if (d(quotation.coverExcess).gt(0)) {
    rows.push(`
          <tr>
            <td colspan="2">Excess</td>
            <td class="shopcare-quote__amount">${t(formattedAmount(quotation, quotation.coverExcess))}</td>
          </tr>`);
  }
  const summary = coverSummary(quotation);
  const actions =
    quotation.status === "sent"
      ? `
      <div class="shopcare-quote__actions">
        ${
          quotation.shopifyDraftOrderUrl?.trim()
            ? `<a class="button" href="${t(quotation.shopifyDraftOrderUrl)}">Pay now</a>`
            : `<p class="shopcare-quote__notice">Your invoice to pay is on its way by email.</p>`
        }
        <details ${choice === "decline" ? "open" : ""}>
          <summary class="button button--secondary">Decline quote</summary>
          <form method="post" action="${t(`${actionBase}/decline`)}">
            <label for="shopcare-decline-reason">Reason (optional)</label>
            <textarea id="shopcare-decline-reason" name="reason" rows="3" maxlength="1000"></textarea>
            <button type="submit" class="button button--secondary">Decline quote</button>
          </form>
        </details>
      </div>
      <p><small>Paying accepts this quote. It's the same invoice we emailed you.</small></p>`
      : "";

  return `${STYLE}
<div class="page-width shopcare-quote">
    <h1>Your repair quote</h1>
    <p>Repair #${ticket.id}${ticket.productTitle?.trim() ? `: ${t(ticket.productTitle)}` : ""}</p>
${error ? `
    <p class="shopcare-quote__notice shopcare-quote__notice--error" role="alert">${t(error)}</p>` : ""}
    ${status}

    <table>
      <thead>
        <tr><th scope="col">Repair</th><th scope="col">Qty</th><th scope="col" class="shopcare-quote__amount">Price</th></tr>
      </thead>
      <tbody>${rows.join("")}
      </tbody>
      <tfoot>
        <tr><th scope="row" colspan="2">Total</th><th class="shopcare-quote__amount">${t(formattedSubtotal(quotation))}</th></tr>
      </tfoot>
    </table>
${summary ? `
    <p><small>${t(summary)}</small></p>` : ""}${actions}
</div>
`;
}

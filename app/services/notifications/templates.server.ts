/**
 * ShopCare's email templates: plain functions from typed data to
 * `{ subject, html, text }`.
 *
 * Every email has the same fixed structure (store header, heading, intro,
 * optional highlighted value, details table, optional button, footer with the
 * store's name and address). Merchants can edit the subject and intro per
 * email; both accept `{{placeholder}}` tokens from the email's `vars`.
 *
 * Everything that comes from a customer, a merchant or a setting is escaped
 * (HTML) or stripped of line breaks (subject); links must be http(s). The
 * markup is table-based with inline styles, because email clients ignore most
 * of CSS, and stays neutral apart from the shop's accent colour.
 */
import type { EventData, EmailKind } from "./events.server";
import { MARKETING_EMAILS } from "./events.server";
import type { ShopNotificationSettings } from "./settings.server";

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

/** What each email is rendered from: the data of the event that sends it. */
export interface EmailData {
  repair_received: EventData["repair_submitted"];
  repair_status_changed: EventData["repair_status_changed"];
  care_welcome: EventData["care_activated"];
  care_credit_issued: EventData["care_credit_offer"];
  care_offer: EventData["care_offer"];
  staff_repair_request: EventData["repair_submitted"];
  staff_quote_paid: EventData["quote_paid"];
  staff_quote_declined: EventData["quote_declined"];
  staff_quote_expired: EventData["quote_expired"];
}

export interface RenderOptions {
  settings: ShopNotificationSettings;
  /** Required for the marketing email; rendering it without one throws. */
  unsubscribeUrl?: string | null;
}

// ---------------------------------------------------------------------------
// Escaping and formatting

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** An http(s) URL, or null. Keeps `javascript:` and friends out of hrefs. */
export function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function singleLine(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Fills `{{name}}` tokens; unknown tokens become empty. Plain text in, plain text out. */
export function fillPlaceholders(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key: string) =>
    Object.hasOwn(vars, key.toLowerCase()) ? vars[key.toLowerCase()] : "",
  );
}

interface Formatters {
  money(amount: number, currency: string): string;
  /** ISO date ("2027-10-16") → "16 October 2027" style; anything else as given. */
  date(iso: string): string;
}

function formatters(locale: string): Formatters {
  return {
    money(amount, currency) {
      try {
        return new Intl.NumberFormat(locale, {
          style: "currency",
          currency,
        }).format(amount);
      } catch {
        return `${amount.toFixed(2)} ${currency}`;
      }
    },
    date(iso) {
      if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso;
      const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
      if (Number.isNaN(date.getTime())) return iso;
      return new Intl.DateTimeFormat(locale, {
        dateStyle: "long",
        timeZone: "UTC",
      }).format(date);
    },
  };
}

const DEFAULT_ACCENT = "#1a1a1a";

function accentColor(value: string | null | undefined): string {
  return value && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)
    ? value.toLowerCase()
    : DEFAULT_ACCENT;
}

function relativeLuminance(hex: string): number {
  const full =
    hex.length === 4
      ? hex
          .slice(1)
          .split("")
          .map((c) => c + c)
          .join("")
      : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const channel = parseInt(full.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** White or near-black, whichever contrasts more with the accent (WCAG ratio). */
function textOn(hex: string): string {
  const l = relativeLuminance(hex);
  const withWhite = 1.05 / (l + 0.05);
  const withBlack = (l + 0.05) / 0.05;
  return withWhite >= withBlack ? "#ffffff" : "#111111";
}

// ---------------------------------------------------------------------------
// Template definitions

type Detail = [label: string, value: string | null | undefined];

interface Template<K extends EmailKind> {
  defaultSubject: (data: EmailData[K]) => string;
  defaultIntro: (data: EmailData[K]) => string;
  heading: (data: EmailData[K], vars: Record<string, string>) => string;
  vars: (data: EmailData[K], f: Formatters) => Record<string, string>;
  highlight?: (
    data: EmailData[K],
    f: Formatters,
  ) => { label: string; value: string } | null;
  details: (data: EmailData[K], f: Formatters) => Detail[];
  button?: (data: EmailData[K]) => { label: string; url?: string | null };
  /** Fixed closing paragraph, after the details. */
  outro?: (data: EmailData[K], vars: Record<string, string>) => string;
}

const STATUS_COPY = {
  assessing: {
    subject: "We're assessing your {{product}} (repair #{{ticket_number}})",
    heading: "We're assessing your repair",
    intro:
      "Your {{product}} has arrived and our team is taking a look. We'll be in touch if anything needs your approval.",
    label: "Being assessed",
  },
  in_repair: {
    subject: "Your {{product}} is being repaired (repair #{{ticket_number}})",
    heading: "Your repair is under way",
    intro: "Good news: work on your {{product}} has started.",
    label: "In repair",
  },
  ready: {
    subject: "Your {{product}} is ready (repair #{{ticket_number}})",
    heading: "Your repair is ready",
    intro:
      "Your {{product}} is repaired and ready. We'll let you know as soon as it's on its way back to you.",
    label: "Ready",
  },
  returned: {
    subject: "Your {{product}} is on its way back (repair #{{ticket_number}})",
    heading: "Your repair is complete",
    intro:
      "Your {{product}} has been repaired and returned to you. Thanks for choosing to repair it.",
    label: "Returned",
  },
} as const;

type StatusCopyKey = keyof typeof STATUS_COPY;

function statusCopy(status: string) {
  const key = (status === "completed" ? "returned" : status) as StatusCopyKey;
  return STATUS_COPY[key] ?? STATUS_COPY.assessing;
}

function greetingName(name: string | null | undefined): string {
  return name?.trim() ? name.trim().split(/\s+/)[0] : "";
}

function quoteAlertDetails(
  d: EmailData[
    "staff_quote_paid" | "staff_quote_declined" | "staff_quote_expired"],
): Detail[] {
  return [
    ["Repair", `#${d.ticketId}`],
    ["Product", d.productTitle],
    ["Customer", d.customerName],
    ["Customer email", d.customerEmail],
    ["Quote total", d.quoteTotal],
  ];
}

function quoteVars(
  d: EmailData[
    "staff_quote_paid" | "staff_quote_declined" | "staff_quote_expired"],
) {
  return {
    ticket_number: String(d.ticketId),
    product: d.productTitle,
    customer_name: d.customerName,
    customer_email: d.customerEmail,
    quote_total: d.quoteTotal,
  };
}

export const TEMPLATES: { [K in EmailKind]: Template<K> } = {
  repair_received: {
    defaultSubject: () =>
      "We've received your repair request (#{{ticket_number}})",
    defaultIntro: () =>
      "Hi {{first_name}}, thanks for your repair request for your {{product}}. We'll review it and let you know the next steps.",
    heading: () => "We've received your repair request",
    vars: (d) => ({
      ticket_number: String(d.ticketId),
      product: d.productTitle,
      customer_name: d.customerName ?? "",
      first_name: greetingName(d.customerName) || "there",
    }),
    details: (d) => [
      ["Repair number", `#${d.ticketId}`],
      ["Product", d.productTitle],
      ["What you told us", d.description],
    ],
    button: (d) => ({ label: "View your repair", url: d.statusUrl }),
  },
  repair_status_changed: {
    defaultSubject: (d) => statusCopy(d.status).subject,
    defaultIntro: (d) => statusCopy(d.status).intro,
    heading: (d) => statusCopy(d.status).heading,
    vars: (d) => ({
      ticket_number: String(d.ticketId),
      product: d.productTitle,
      status: statusCopy(d.status).label,
      customer_name: d.customerName ?? "",
      first_name: greetingName(d.customerName) || "there",
    }),
    details: (d) => [
      ["Repair number", `#${d.ticketId}`],
      ["Product", d.productTitle],
      ["Status", statusCopy(d.status).label],
    ],
    button: (d) => ({ label: "View your repair", url: d.statusUrl }),
  },
  care_welcome: {
    defaultSubject: () => "Your {{care_plan}} for {{product}} has started",
    defaultIntro: () =>
      "Hi {{first_name}}, your {{product}} is now covered by {{care_plan}}. Keep this email: it has the details you'll need if anything goes wrong.",
    heading: () => "Welcome to Care",
    vars: (d, f) => ({
      care_plan: d.carePlan,
      product: d.productTitle,
      cover_ends: f.date(d.coverEnds),
      customer_name: d.customerName ?? "",
      first_name: greetingName(d.customerName) || "there",
    }),
    details: (d, f) => [
      ["Plan", d.carePlan],
      ["Product", d.productTitle],
      ["Covered until", f.date(d.coverEnds)],
    ],
  },
  care_credit_issued: {
    defaultSubject: () => "Your {{credit_amount}} credit code from {{store}}",
    defaultIntro: () =>
      "Hi {{first_name}}, your {{product}} was refunded, so instead of losing the value of its {{care_plan}} you have a credit code to spend with us.",
    heading: () => "Here's your credit code",
    vars: (d, f) => ({
      care_plan: d.carePlan,
      product: d.productTitle,
      credit_code: d.creditCode,
      credit_amount: f.money(d.creditAmount, d.currency),
      credit_expires: d.creditExpires ? f.date(d.creditExpires) : "",
      customer_name: d.customerName ?? "",
      first_name: greetingName(d.customerName) || "there",
    }),
    highlight: (d, f) => ({
      label: `Credit code (${f.money(d.creditAmount, d.currency)})`,
      value: d.creditCode,
    }),
    details: (d, f) => [
      ["Value", f.money(d.creditAmount, d.currency)],
      ["Expires", d.creditExpires ? f.date(d.creditExpires) : "Never"],
      ["From", `${d.carePlan} on ${d.productTitle}`],
    ],
    button: (d) => ({ label: "Shop now", url: d.storeUrl }),
    outro: () => "Enter the code at checkout to use your credit.",
  },
  care_offer: {
    defaultSubject: () => "Add {{care_plan}} to your {{product}}",
    defaultIntro: () =>
      "Hi {{first_name}}, there's still time to protect your {{product}} with {{care_plan}}.",
    heading: () => "Add Care to your purchase",
    vars: (d, f) => ({
      care_plan: d.carePlan,
      product: d.productTitle,
      care_price: f.money(d.carePrice, d.currency),
      offer_ends: f.date(d.offerEnds),
      customer_name: d.customerName ?? "",
      first_name: greetingName(d.customerName) || "there",
    }),
    details: (d, f) => [
      ["Plan", d.carePlan],
      ["For", d.productTitle],
      ["Price", f.money(d.carePrice, d.currency)],
      ["Offer ends", f.date(d.offerEnds)],
    ],
    button: (d) => ({ label: "Add Care", url: d.addCareUrl }),
  },
  staff_repair_request: {
    defaultSubject: () => "New repair request #{{ticket_number}}: {{product}}",
    defaultIntro: () =>
      "{{customer_name}} has submitted a repair request for their {{product}}.",
    heading: () => "New repair request",
    vars: (d) => ({
      ticket_number: String(d.ticketId),
      product: d.productTitle,
      customer_name: d.customerName || "A customer",
      customer_email: d.customerEmail ?? "",
    }),
    details: (d) => [
      ["Repair number", `#${d.ticketId}`],
      ["Product", d.productTitle],
      ["Customer", d.customerName],
      ["Customer email", d.customerEmail],
      ["Description", d.description],
    ],
    button: (d) => ({ label: "Open in ShopCare", url: d.adminUrl }),
  },
  staff_quote_paid: {
    defaultSubject: () =>
      "Quote paid for repair #{{ticket_number}} ({{order_name}})",
    defaultIntro: () =>
      "{{customer_name}} has paid their quote for {{product}}, so the repair can start.",
    heading: () => "Repair quote paid",
    vars: (d) => ({ ...quoteVars(d), order_name: d.orderName }),
    details: (d) => [...quoteAlertDetails(d), ["Order", d.orderName]],
    button: (d) => ({ label: "Open in ShopCare", url: d.adminUrl }),
  },
  staff_quote_declined: {
    defaultSubject: () => "Quote declined for repair #{{ticket_number}}",
    defaultIntro: () =>
      "{{customer_name}} has declined their quote for {{product}}. Its invoice no longer works.",
    heading: () => "Repair quote declined",
    vars: (d) => ({ ...quoteVars(d), reason: d.reason }),
    details: (d) => [
      ...quoteAlertDetails(d),
      ["Reason", d.reason || "No reason given"],
    ],
    button: (d) => ({ label: "Open in ShopCare", url: d.adminUrl }),
  },
  staff_quote_expired: {
    defaultSubject: () => "Quote expired for repair #{{ticket_number}}",
    defaultIntro: () =>
      "The quote for {{customer_name}}'s {{product}} expired unpaid. Revise and resend it from the ticket if needed.",
    heading: () => "Repair quote expired",
    vars: (d, f) => ({ ...quoteVars(d), valid_until: f.date(d.validUntil) }),
    details: (d, f) => [
      ...quoteAlertDetails(d),
      ["Valid until", f.date(d.validUntil)],
    ],
    button: (d) => ({ label: "Open in ShopCare", url: d.adminUrl }),
  },
};

/** The placeholders an email's subject and intro accept, for the Settings page. */
export function placeholdersFor<K extends EmailKind>(
  kind: K,
  sample: EmailData[K],
): string[] {
  const template = TEMPLATES[kind] as Template<K>;
  return ["store", ...Object.keys(template.vars(sample, formatters("en")))];
}

// ---------------------------------------------------------------------------
// Rendering

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const TEXT = "#1f1f1f";
const MUTED = "#5c5c5c";
const BORDER = "#e3e3e3";

function paragraphs(text: string, style: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(
      (block) =>
        `<p style="${style}">${escapeHtml(block).replace(/\n/g, "<br>")}</p>`,
    )
    .join("\n");
}

export function renderEmail<K extends EmailKind>(
  kind: K,
  data: EmailData[K],
  { settings, unsubscribeUrl }: RenderOptions,
): EmailContent {
  const template = TEMPLATES[kind] as Template<K>;
  const marketing = MARKETING_EMAILS.includes(kind);
  const unsubscribe = safeUrl(unsubscribeUrl);
  if (marketing && !unsubscribe) {
    throw new Error(
      `${kind} is a marketing email and needs an unsubscribe link.`,
    );
  }

  const f = formatters(settings.locale || "en");
  const vars = { store: settings.shopName, ...template.vars(data, f) };
  const custom = settings.emails?.[kind];

  const subject = singleLine(
    fillPlaceholders(
      custom?.subject?.trim() || template.defaultSubject(data),
      vars,
    ),
  );
  const intro = fillPlaceholders(
    custom?.intro?.trim() || template.defaultIntro(data),
    vars,
  ).trim();
  const heading = template.heading(data, vars);
  const highlight = template.highlight?.(data, f) ?? null;
  const details = template
    .details(data, f)
    .filter((row): row is [string, string] => Boolean(row[1]?.trim()));
  const button = template.button?.(data);
  const buttonUrl = safeUrl(button?.url);
  const outro = template.outro?.(data, vars) ?? "";

  const accent = accentColor(settings.accentColor);
  const onAccent = textOn(accent);
  const logo = safeUrl(settings.logoUrl);
  const storeUrl = safeUrl(settings.storeUrl);
  const address = (settings.addressLines ?? [])
    .map((line) => line.trim())
    .filter(Boolean);
  const shopName = escapeHtml(settings.shopName);

  // ---- HTML
  const header = logo
    ? `<img src="${escapeHtml(logo)}" alt="${shopName}" height="40" style="display:block;height:40px;width:auto;max-width:200px;border:0;">`
    : `<span style="font-size:20px;font-weight:600;color:${TEXT};">${shopName}</span>`;
  const headerCell = storeUrl
    ? `<a href="${escapeHtml(storeUrl)}" style="text-decoration:none;color:${TEXT};">${header}</a>`
    : header;

  const highlightHtml = highlight
    ? `<tr><td style="padding:0 32px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:2px dashed ${accent};border-radius:6px;">
<tr><td style="padding:16px;text-align:center;">
<p style="margin:0 0 4px;font-size:13px;color:${MUTED};">${escapeHtml(highlight.label)}</p>
<p style="margin:0;font-size:24px;font-weight:700;letter-spacing:2px;color:${TEXT};font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;">${escapeHtml(highlight.value)}</p>
</td></tr></table></td></tr>`
    : "";

  const detailsHtml = details.length
    ? `<tr><td style="padding:0 32px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${BORDER};">
${details
  .map(
    ([label, value]) =>
      `<tr><th scope="row" align="left" valign="top" style="padding:10px 12px 10px 0;border-bottom:1px solid ${BORDER};font-size:14px;font-weight:600;color:${MUTED};width:40%;">${escapeHtml(label)}</th><td valign="top" style="padding:10px 0;border-bottom:1px solid ${BORDER};font-size:14px;color:${TEXT};">${escapeHtml(value).replace(/\n/g, "<br>")}</td></tr>`,
  )
  .join("\n")}
</table></td></tr>`
    : "";

  const buttonHtml =
    button && buttonUrl
      ? `<tr><td style="padding:0 32px 24px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:6px;background:${accent};">
<a href="${escapeHtml(buttonUrl)}" style="display:inline-block;padding:12px 24px;font-size:16px;font-weight:600;color:${onAccent};text-decoration:none;border-radius:6px;">${escapeHtml(button.label)}</a>
</td></tr></table></td></tr>`
      : "";

  const outroHtml = outro
    ? `<tr><td style="padding:0 32px 24px;">${paragraphs(outro, `margin:0;font-size:16px;line-height:1.5;color:${TEXT};`)}</td></tr>`
    : "";

  const footerLines = [
    `<p style="margin:0 0 4px;font-weight:600;">${shopName}</p>`,
    address.length
      ? `<p style="margin:0 0 12px;">${address.map(escapeHtml).join("<br>")}</p>`
      : "",
    marketing && unsubscribe
      ? `<p style="margin:0 0 8px;">You're receiving this because you agreed to hear from ${shopName}. <a href="${escapeHtml(unsubscribe)}" style="color:${MUTED};text-decoration:underline;">Unsubscribe</a></p>`
      : "",
    `<p style="margin:0;">Sent by ShopCare on behalf of ${shopName}.</p>`,
  ]
    .filter(Boolean)
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="${escapeHtml(settings.locale || "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(intro.split("\n")[0])}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${BORDER};border-radius:8px;font-family:${FONT};">
<tr><td style="padding:24px 32px;border-bottom:3px solid ${accent};">${headerCell}</td></tr>
<tr><td style="padding:32px 32px 8px;">
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;color:${TEXT};">${escapeHtml(heading)}</h1>
${paragraphs(intro, `margin:0 0 16px;font-size:16px;line-height:1.5;color:${TEXT};`)}
</td></tr>
${[highlightHtml, detailsHtml, buttonHtml, outroHtml].filter(Boolean).join("\n")}
<tr><td style="padding:24px 32px;border-top:1px solid ${BORDER};font-size:12px;line-height:1.5;color:${MUTED};">
${footerLines}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;

  // ---- Text
  const width = Math.max(0, ...details.map(([label]) => label.length));
  const text = [
    settings.shopName,
    "",
    heading,
    "",
    intro,
    highlight ? `\n${highlight.label}: ${highlight.value}` : null,
    details.length
      ? "\n" +
        details
          .map(([label, value]) => `${`${label}:`.padEnd(width + 2)}${value}`)
          .join("\n")
      : null,
    button && buttonUrl ? `\n${button.label}: ${buttonUrl}` : null,
    outro ? `\n${outro}` : null,
    "",
    "--",
    settings.shopName,
    ...address,
    marketing && unsubscribe ? `Unsubscribe: ${unsubscribe}` : null,
    `Sent by ShopCare on behalf of ${settings.shopName}.`,
  ]
    .filter((line) => line !== null)
    .join("\n")
    .concat("\n");

  return { subject, html, text };
}

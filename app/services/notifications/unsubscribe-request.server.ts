/**
 * The unsubscribe page's logic (app/routes/email.unsubscribe.tsx), kept out
 * of the route so it's testable: GET shows a confirmation form (link
 * scanners that prefetch GETs mustn't unsubscribe anyone); POST, including
 * the RFC 8058 one-click POST mail clients send for List-Unsubscribe-Post,
 * records the per-shop marketing opt-out in the suppression list and queues
 * the Shopify consent update ("marketing-unsubscribe" job).
 */
import prisma from "../../db.server";
import type { JobPayload } from "../../jobs/registry.server";
import { escapeHtml } from "./templates.server";
import { suppressEmail } from "./suppressions.server";
import { verifyUnsubscribeToken } from "./unsubscribe.server";

export interface UnsubscribeDeps {
  db?: typeof prisma;
  enqueue?: (name: "marketing-unsubscribe", payload: JobPayload) => Promise<void>;
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222;line-height:1.5}
button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:6px;background:#222;color:#fff;cursor:pointer}</style>
</head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

const invalid = () =>
  page("Link not valid", "<p>This unsubscribe link isn't valid. Use the link in the latest email.</p>", 400);

const shopLabel = (shop: string) => shop.replace(/\.myshopify\.com$/, "");

export function unsubscribeForm(request: Request): Response {
  const token = new URL(request.url).searchParams.get("token");
  const claims = verifyUnsubscribeToken(token);
  if (!claims) return invalid();
  return page(
    "Unsubscribe",
    `<p>Stop marketing emails from <strong>${escapeHtml(shopLabel(claims.shop))}</strong> to ${escapeHtml(claims.email)}?</p>
<form method="post"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Unsubscribe</button></form>
<p><small>You'll still get emails about your repairs and Care plans.</small></p>`,
  );
}

export async function unsubscribe(
  request: Request,
  { db = prisma, enqueue }: UnsubscribeDeps = {},
): Promise<Response> {
  let token = new URL(request.url).searchParams.get("token");
  if (!token) {
    const form = await request.formData().catch(() => null);
    const value = form?.get("token");
    token = typeof value === "string" ? value : null;
  }
  const claims = verifyUnsubscribeToken(token);
  if (!claims) return invalid();

  const shop = await db.shop.findUnique({ where: { shopifyDomain: claims.shop } });
  if (shop) {
    await suppressEmail(
      { shopId: shop.id, email: claims.email, kind: "marketing", reason: "unsubscribe" },
      db,
    );
    if (claims.customerId && !shop.uninstalledAt) {
      try {
        const run = enqueue ?? (await import("../../lib/background.server")).enqueue;
        await run("marketing-unsubscribe", { shop: claims.shop, customerId: claims.customerId });
      } catch (error) {
        console.error(`[unsubscribe] Shopify consent update not queued for ${claims.shop}`, error);
      }
    }
  }
  return page(
    "You're unsubscribed",
    `<p>${escapeHtml(claims.email)} won't get marketing emails from <strong>${escapeHtml(shopLabel(claims.shop))}</strong> any more.</p>`,
  );
}

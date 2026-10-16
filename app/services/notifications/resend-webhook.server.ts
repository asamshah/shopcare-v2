/**
 * Resend's event webhook (app/routes/webhooks.email.tsx): bounces and spam
 * complaints feed the suppression list, so ShopCare stops emailing those
 * addresses.
 *
 *   email.bounced     permanent bounces only (`bounce.type` "Permanent"):
 *                     every address suppressed globally ("all"); a transient
 *                     bounce is ignored
 *   email.complained  suppressed ("all") for the shop that sent it, found
 *                     from the delivery with that provider message id; global
 *                     when no delivery matches
 * The matching delivery gets the bounce/complaint in its `error`.
 *
 * Signatures (Svix, as Resend documents): headers svix-id, svix-timestamp,
 * svix-signature ("v1,<base64>" entries, space-separated); the signed content
 * is `${id}.${timestamp}.${rawBody}`, HMAC-SHA256 with the base64 part of the
 * `whsec_…` secret (RESEND_WEBHOOK_SECRET); timestamps more than 5 minutes
 * off are rejected.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import prisma from "../../db.server";
import { suppressEmail } from "./suppressions.server";

export const TOLERANCE_SECONDS = 5 * 60;

export function verifySvixSignature(
  rawBody: string,
  headers: Headers,
  secret: string | undefined,
  now = Date.now(),
): boolean {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!secret || !id || !timestamp || !signatures) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  return signatures.split(" ").some((entry) => {
    const [version, signature] = entry.split(",");
    if (version !== "v1" || !signature) return false;
    const given = Buffer.from(signature, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

interface ResendEvent {
  type?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    bounce?: { type?: string; subType?: string; message?: string };
  };
}

export async function handleResendEvent(
  event: ResendEvent,
  db = prisma,
): Promise<{ suppressed: number }> {
  const data = event.data ?? {};
  const recipients = [data.to ?? []].flat().filter((to): to is string => typeof to === "string" && to.includes("@"));
  const delivery = data.email_id
    ? await db.notificationDelivery.findFirst({ where: { providerMessageId: data.email_id } })
    : null;

  if (event.type === "email.bounced") {
    if ((data.bounce?.type ?? "").toLowerCase() !== "permanent") return { suppressed: 0 };
    const detail = [data.bounce?.subType, data.bounce?.message].filter(Boolean).join(": ").slice(0, 500);
    for (const email of recipients)
      await suppressEmail({ shopId: null, email, kind: "all", reason: "bounce", detail }, db);
    if (delivery)
      await db.notificationDelivery.update({
        where: { id: delivery.id },
        data: { error: `Bounced${detail ? `: ${detail}` : ""}`.slice(0, 500) },
      });
    return { suppressed: recipients.length };
  }
  if (event.type === "email.complained") {
    for (const email of recipients)
      await suppressEmail(
        { shopId: delivery?.shopId ?? null, email, kind: "all", reason: "complaint" },
        db,
      );
    if (delivery)
      await db.notificationDelivery.update({
        where: { id: delivery.id },
        data: { error: "Marked as spam by the recipient" },
      });
    return { suppressed: recipients.length };
  }
  return { suppressed: 0 };
}

export async function resendWebhook(
  request: Request,
  { db = prisma, secret = process.env.RESEND_WEBHOOK_SECRET, now = Date.now() } = {},
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const body = await request.text();
  if (!verifySvixSignature(body, request.headers, secret, now))
    return new Response("Invalid signature", { status: 401 });
  let event: ResendEvent;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  await handleResendEvent(event, db);
  return new Response(null, { status: 200 });
}

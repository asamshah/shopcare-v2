/**
 * GDPR `customers/data_request`: builds a real export of everything ShopCare
 * holds about one customer of a shop and gets it to the merchant, who must
 * answer the customer. (Rails only logged the counts.)
 *
 *   1. Collects the customer's repair tickets (with activity log, quotes and
 *      their lines, photo metadata, a link to the stored postage slip), items (with cover and registration),
 *      trade-ins and notification log entries (matching rules in
 *      customer-match.server.ts). Internal secrets (quote token ciphertext
 *      and digest) are left out.
 *   2. Stores it as JSON in file storage under
 *      `gdpr-exports/<shop>/<request id>.json` and remembers the key in
 *      `settings.gdpr_exports` (the daily prune deletes exports after
 *      EXPORT_RETENTION_DAYS; shop/redact deletes them with the shop).
 *   3. Emails the merchant (Notify-staff address, else support/contact email,
 *      else the shop owner's Shopify email) a signed download link valid for
 *      EXPORT_LINK_DAYS, with photo links inside the export valid as long.
 *
 * Idempotent per data request: the storage key and the email idempotency key
 * are both the request id, so a retried webhook overwrites the same file and
 * the provider drops the repeat email.
 */
import type { Prisma, Shop } from "@prisma/client";
import prisma from "../../db.server";
import { sendEmail } from "../email.server";
import { getStorage, signedUrl, type FileStorage } from "../../lib/storage.server";
import { notificationsSettings, settingsOf } from "../../models/shop.server";
import { escapeHtml } from "../notifications/templates.server";
import {
  itemWhere,
  matchingDeliveryIds,
  ticketWhere,
  tradeInWhere,
  type CustomerRef,
} from "./customer-match.server";

export const EXPORT_LINK_DAYS = 14;
export const EXPORT_RETENTION_DAYS = 30;
const DAY_SECONDS = 86_400;

export interface ExportOptions {
  db?: typeof prisma;
  storage?: FileStorage;
  now?: Date;
  /** The shop owner's email from Shopify, asked only when no address is set. */
  shopOwnerEmail?: () => Promise<string | null>;
  send?: typeof sendEmail;
}

export interface ExportResult {
  key: string;
  url: string;
  emailedTo: string | null;
  counts: { tickets: number; items: number; tradeIns: number; deliveries: number };
}

const omit = <T extends Record<string, unknown>>(row: T, ...fields: string[]) =>
  Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key)));

export async function buildCustomerExport(
  shop: Pick<Shop, "id" | "shopifyDomain">,
  ref: CustomerRef,
  { db = prisma, now = new Date() }: { db?: typeof prisma; now?: Date } = {},
) {
  const linkSeconds = EXPORT_LINK_DAYS * DAY_SECONDS;
  const tickets = await db.repairTicket.findMany({
    where: ticketWhere(shop.id, ref),
    include: {
      activities: { orderBy: { createdAt: "asc" } },
      ticketImages: true,
      quotations: { include: { lineItems: true }, orderBy: { createdAt: "asc" } },
    },
    orderBy: { id: "asc" },
  });
  const items = await db.item.findMany({
    where: itemWhere(shop.id, ref),
    include: { covers: true, registration: true },
    orderBy: { id: "asc" },
  });
  const tradeIns = await db.tradeIn.findMany({
    where: tradeInWhere(shop.id, ref),
    orderBy: { id: "asc" },
  });
  const deliveryIds = await matchingDeliveryIds(db, shop.id, ref);
  const deliveries = deliveryIds.length
    ? await db.notificationDelivery.findMany({
        where: { id: { in: deliveryIds } },
        orderBy: { id: "asc" },
      })
    : [];

  const fileLink = (key: string | null) =>
    key ? signedUrl(key, { expiresInSeconds: linkSeconds, now: now.getTime() }) : null;

  return {
    generated_at: now.toISOString(),
    shop: shop.shopifyDomain,
    customer: { shopify_customer_id: ref.customerId, email: ref.email, orders: ref.orderIds },
    repair_tickets: tickets.map((ticket) => ({
      ...omit(ticket, "ticketImages", "quotations", "activities", "postageSlipKey", "postageSlipDigest"),
      postage_slip_url: fileLink(ticket.postageSlipKey),
      activities: ticket.activities,
      photos: ticket.ticketImages.map((image) => ({
        filename: image.filename,
        content_type: image.contentType,
        byte_size: image.byteSize,
        url: image.url ?? fileLink(image.storageKey),
      })),
      quotes: ticket.quotations.map((quotation) =>
        omit(quotation, "decisionTokenCiphertext", "decisionTokenDigest"),
      ),
    })),
    items: items.map((item) => ({
      ...omit(item, "registration"),
      registration: item.registration
        ? { ...omit(item.registration, "proofKey"), proof_url: fileLink(item.registration.proofKey) }
        : null,
    })),
    trade_ins: tradeIns.map((tradeIn) => ({
      ...tradeIn,
      photos: (Array.isArray(tradeIn.photos) ? tradeIn.photos : []).map((photo) => {
        const p = (photo ?? {}) as Record<string, unknown>;
        return { ...p, url: typeof p.key === "string" ? fileLink(p.key) : null };
      }),
    })),
    notifications: deliveries.map((delivery) =>
      omit(delivery, "idempotencyKey", "providerMessageId"),
    ),
  };
}

function merchantAddress(shop: Pick<Shop, "settings">): string | null {
  const n = notificationsSettings(shop);
  for (const value of [n.staff_email, n.support_email, settingsOf(shop).contact_email]) {
    if (typeof value === "string" && value.trim()) return value.split(/[,;]/)[0].trim();
  }
  return null;
}

export async function exportCustomerData(
  shop: Shop,
  ref: CustomerRef,
  requestId: string,
  {
    db = prisma,
    storage = getStorage(),
    now = new Date(),
    shopOwnerEmail,
    send = sendEmail,
  }: ExportOptions = {},
): Promise<ExportResult> {
  const data = await buildCustomerExport(shop, ref, { db, now });
  const safeId = requestId.replace(/[^A-Za-z0-9_-]/g, "_") || String(now.getTime());
  const key = `gdpr-exports/${shop.shopifyDomain}/${safeId}.json`;
  await storage.put(key, JSON.stringify(data, null, 2), {
    contentType: "application/json",
    metadata: { shop: shop.shopifyDomain, request: safeId },
  });

  // Remember it so the prune and shop/redact can delete it.
  const fresh = await db.shop.findUniqueOrThrow({ where: { id: shop.id } });
  const exports = (settingsOf(fresh).gdpr_exports as { key: string }[] | undefined) ?? [];
  if (!exports.some((entry) => entry.key === key)) {
    await db.shop.update({
      where: { id: shop.id },
      data: {
        settings: {
          ...settingsOf(fresh),
          gdpr_exports: [...exports, { key, request_id: safeId, created_at: now.toISOString() }],
        } as Prisma.InputJsonValue,
      },
    });
  }

  const url = signedUrl(key, { expiresInSeconds: EXPORT_LINK_DAYS * DAY_SECONDS, now: now.getTime() });
  const counts = {
    tickets: data.repair_tickets.length,
    items: data.items.length,
    tradeIns: data.trade_ins.length,
    deliveries: data.notifications.length,
  };
  const to = merchantAddress(fresh) ?? (shopOwnerEmail ? await shopOwnerEmail() : null);
  if (to) {
    const who = ref.email ?? (ref.customerId ? `customer ${ref.customerId}` : "a customer");
    const summary =
      `${counts.tickets} repair ticket(s), ${counts.items} item(s), ` +
      `${counts.tradeIns} trade-in(s), ${counts.deliveries} notification(s)`;
    const text = [
      `Shopify passed on a data request from ${who}.`,
      `ShopCare's export of what it holds about them (${summary}) is ready:`,
      url,
      `The link works for ${EXPORT_LINK_DAYS} days; the file is deleted after ${EXPORT_RETENTION_DAYS}. Send the customer what they asked for.`,
    ].join("\n\n");
    await send({
      shopId: shop.shopifyDomain,
      to,
      subject: `Customer data request: ShopCare export for ${shop.shopifyDomain}`,
      text,
      html: text
        .split("\n\n")
        .map((p) =>
          p === url
            ? `<p><a href="${escapeHtml(url)}">Download the export (JSON)</a></p>`
            : `<p>${escapeHtml(p)}</p>`,
        )
        .join(""),
      fromName: "ShopCare",
      tags: { event: "gdpr_data_request" },
      idempotencyKey: `${shop.shopifyDomain}:gdpr-export:${safeId}`,
    });
  } else {
    console.error(
      `[gdpr/export] ${shop.shopifyDomain}: export ${key} stored but no merchant email to send it to`,
    );
  }
  return { key, url, emailedTo: to, counts };
}

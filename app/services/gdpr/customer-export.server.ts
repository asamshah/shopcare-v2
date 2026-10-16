/**
 * GDPR `customers/data_request`: builds a real export of everything ShopCare
 * holds about one customer of a shop and puts it in front of the merchant,
 * who must answer the customer. (Rails only logged the counts.)
 *
 *   1. Collects the customer's repair tickets (with activity log, quotes and
 *      their lines, photo metadata, a link to the stored postage slip), items (with cover and registration),
 *      trade-ins and notification log entries (matching rules in
 *      customer-match.server.ts). Internal secrets (quote token ciphertext
 *      and digest) are left out.
 *   2. Stores it as JSON in file storage under
 *      `gdpr-exports/<shop>/<request id>.json` and remembers it in
 *      `settings.gdpr_exports` with who asked and the counts (the daily prune
 *      deletes exports after EXPORT_RETENTION_DAYS; shop/redact deletes them
 *      with the shop).
 *   3. The admin shows it (home page banner, Settings → Customer data
 *      requests) with a signed download link; photo links inside the export
 *      are valid for EXPORT_LINK_DAYS. ShopCare sends no email: merchants who
 *      want one wire the "Customer data request" Flow trigger to Flow's
 *      "Send internal email".
 *
 * Idempotent per data request: the storage key is the request id, so a
 * retried webhook overwrites the same file and entry.
 */
import type { Prisma, Shop } from "@prisma/client";
import prisma from "../../db.server";
import { getStorage, signedUrl, type FileStorage } from "../../lib/storage.server";
import { settingsOf } from "../../models/shop.server";
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
}

export interface ExportCounts {
  tickets: number;
  items: number;
  tradeIns: number;
  deliveries: number;
}

/** One entry of settings.gdpr_exports, as the admin lists them. */
export interface GdprExportEntry {
  key: string;
  request_id: string;
  created_at: string;
  /** The customer's email, else "customer <id>". */
  customer?: string;
  counts?: ExportCounts;
}

export interface ExportResult {
  key: string;
  url: string;
  customer: string;
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

export async function exportCustomerData(
  shop: Shop,
  ref: CustomerRef,
  requestId: string,
  {
    db = prisma,
    storage = getStorage(),
    now = new Date(),
  }: ExportOptions = {},
): Promise<ExportResult> {
  const data = await buildCustomerExport(shop, ref, { db, now });
  const safeId = requestId.replace(/[^A-Za-z0-9_-]/g, "_") || String(now.getTime());
  const key = `gdpr-exports/${shop.shopifyDomain}/${safeId}.json`;
  await storage.put(key, JSON.stringify(data, null, 2), {
    contentType: "application/json",
    metadata: { shop: shop.shopifyDomain, request: safeId },
  });

  const counts: ExportCounts = {
    tickets: data.repair_tickets.length,
    items: data.items.length,
    tradeIns: data.trade_ins.length,
    deliveries: data.notifications.length,
  };
  const customer = ref.email ?? (ref.customerId ? `customer ${ref.customerId}` : "a customer");

  // Remember it so the admin can list it and the prune and shop/redact can delete it.
  const fresh = await db.shop.findUniqueOrThrow({ where: { id: shop.id } });
  const exports = (settingsOf(fresh).gdpr_exports as GdprExportEntry[] | undefined) ?? [];
  const entry: GdprExportEntry = { key, request_id: safeId, created_at: now.toISOString(), customer, counts };
  await db.shop.update({
    where: { id: shop.id },
    data: {
      settings: {
        ...settingsOf(fresh),
        gdpr_exports: [...exports.filter((e) => e.key !== key), entry],
      } as unknown as Prisma.InputJsonValue,
    },
  });

  const url = signedUrl(key, { expiresInSeconds: EXPORT_LINK_DAYS * DAY_SECONDS, now: now.getTime() });
  return { key, url, customer, counts };
}

/** The shop's stored exports, newest first. */
export function gdprExports(shop: Pick<Shop, "settings">): GdprExportEntry[] {
  const list = settingsOf(shop).gdpr_exports;
  return (Array.isArray(list) ? (list as GdprExportEntry[]) : [])
    .filter((e) => e && typeof e.key === "string")
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

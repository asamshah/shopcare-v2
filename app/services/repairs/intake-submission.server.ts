/**
 * Creates a RepairTicket from a storefront intake submission (received via
 * the signed App Proxy, app/routes/proxy.intake.tsx). Port of
 * Repairs::IntakeSubmission.
 *
 * The shop and the customer id come from trusted App Proxy params; everything
 * else is customer-supplied form input. A chosen item (a purchase, a
 * registered product, or a line of an order a guest verified with its email)
 * is re-verified here: if it can't be, the request is refused rather than
 * filed against an item the customer may not own.
 *
 * After the ticket is saved: photos go to file storage (best effort: a
 * rejected file doesn't fail the ticket), the merchant's outbound webhook gets
 * "submitted", and the repair_submitted notification is emitted (customer
 * "request received" + staff alert; new in v2).
 */
import { randomUUID } from "node:crypto";
import type { Cover, Prisma, RepairTicket, Shop } from "@prisma/client";
import prisma from "../../db.server";
import type { JobPayload } from "../../jobs/registry.server";
import { emitOutboundWebhook } from "../../jobs/outbound-webhook.server";
import type { Db } from "../../lib/db-lock.server";
import { castBoolean } from "../../lib/inflections";
import type { FileStorage } from "../../lib/storage.server";
import { coverName, coverOutcomeLabel } from "../../models/cover.server";
import { COVERS_ORDER, type ItemWithCovers } from "../../models/item.server";
import {
  createRepairTicket,
  linkItem,
  openWhere,
} from "../../models/repair-ticket.server";
import { settingsOf } from "../../models/shop.server";
import { createTicketActivity } from "../../models/ticket-activity.server";
import { sniffImageType } from "../../lib/image-type";
import { createTicketImage, MAX_BYTES, validateTicketImage } from "../../models/ticket-image.server";
import { ValidationError } from "../../models/validation.server";
import { emitNotification, type NotificationDeps } from "../notifications.server";
import { loadNotificationSettings } from "../notifications/shop-settings.server";
import type { ItemResolver } from "../storefront/owned-item-resolver.server";
import { verifiedOrderId } from "./order-lookup.server";

export const DEFAULT_MAX_IMAGES = 6;
export const UNVERIFIED =
  "We couldn't confirm that purchase. Please choose it again, or describe the item instead.";
export const ALREADY_OPEN = "A repair is already open for this item. We'll be in touch about it.";
const REQUIRED = ["description", "customer_email"] as const;
const ADDRESS_KEYS = ["address1", "address2", "city", "province", "zip", "country"] as const;

/** The permitted form fields (Rails `intake_params`). */
export interface IntakeParams {
  description?: string | null;
  customer_email?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  product_id?: string | null;
  variant_id?: string | null;
  product_title?: string | null;
  variant_title?: string | null;
  order_number?: string | null;
  order_date?: string | null;
  no_order_history?: string | null;
  item_id?: string | null;
  order_id?: string | null;
  order_line_id?: string | null;
  order_token?: string | null;
  unverified_purchase?: string | null;
  customer_address?: Record<string, string | null | undefined> | null;
}

export const INTAKE_FIELDS = [
  "description",
  "customer_email",
  "customer_name",
  "customer_phone",
  "product_id",
  "variant_id",
  "product_title",
  "variant_title",
  "order_number",
  "order_date",
  "no_order_history",
  "item_id",
  "order_id",
  "order_line_id",
  "order_token",
  "unverified_purchase",
] as const;
export const INTAKE_ADDRESS_KEYS = ADDRESS_KEYS;

/** An uploaded photo (a web `File`). */
export interface IntakeUpload {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type IntakeResult =
  | { ok: true; ticket: RepairTicket }
  | { ok: false; errors: string[] };

export interface IntakeOptions {
  customerId?: string | null;
  images?: unknown[];
  /** Resolves a chosen purchase / registered product for a logged-in customer. */
  itemResolver?: ItemResolver | null;
  storage: FileStorage;
  /** Notifications deps; null skips the notification (it never fails the intake). */
  notifications?: Pick<NotificationDeps, "store" | "enqueue"> | null;
  enqueue?: (name: "outbound-webhook", payload: JobPayload) => Promise<void>;
  db?: typeof prisma;
  now?: Date;
  logger?: Pick<Console, "error">;
}

const blank = (value: unknown) =>
  value === null || value === undefined || String(value).trim() === "";

export async function submitIntake(
  shop: Shop,
  params: IntakeParams,
  options: IntakeOptions,
): Promise<IntakeResult> {
  const { db = prisma, now = new Date(), logger = console } = options;
  const missing = REQUIRED.filter((field) => blank(params[field]));
  if (missing.length) return { ok: false, errors: missing.map((f) => `${f} is required`) };

  const customerId = blank(options.customerId) ? null : String(options.customerId);
  const chosen = itemChosen(params);
  const item = chosen ? await resolveItem(shop, params, customerId, options.itemResolver, db) : null;
  if (chosen && !item) return { ok: false, errors: [UNVERIFIED] };
  if (item) {
    const open = await db.repairTicket.count({
      where: { shopId: shop.id, itemId: item.id, ...openWhere },
    });
    if (open > 0) return { ok: false, errors: [ALREADY_OPEN] };
  }

  let ticket: RepairTicket;
  try {
    ticket = await db.$transaction(async (tx) => {
      const link = item ? linkItem(item, now) : {};
      const created = await createRepairTicket(
        { ...ticketAttributes(shop, params, customerId), ...itemAttributes(item), ...link },
        tx,
      );
      await createTicketActivity(
        {
          repairTicketId: created.id,
          activityType: "system",
          author: "customer",
          body: "Repair request submitted via storefront.",
        },
        tx,
      );
      const cover = item && created.coverId ? item.covers.find((c) => c.id === created.coverId) : null;
      if (cover) await logCover(created.id, cover, tx);
      if (!item && castBoolean(params.unverified_purchase)) {
        await createTicketActivity(
          {
            repairTicketId: created.id,
            activityType: "system",
            author: "system",
            body: "Product chosen from the catalogue: purchase not verified, no cover applied.",
          },
          tx,
        );
      }
      return created;
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return { ok: false, errors: [`Validation failed: ${error.errors.fullMessages().join(", ")}`] };
    }
    throw error;
  }

  await attachImages(shop, ticket, options.images ?? [], options.storage, db, logger);
  await announce(shop, ticket, options, logger);
  return { ok: true, ticket };
}

function itemChosen(params: IntakeParams): boolean {
  return !blank(params.item_id) || !blank(params.order_line_id) || !blank(params.order_token);
}

/**
 * The Item the customer picked, only if it's theirs: a line of an order they
 * verified (order token), else one of their purchases or registered products.
 */
async function resolveItem(
  shop: Shop,
  params: IntakeParams,
  customerId: string | null,
  resolver: ItemResolver | null | undefined,
  db: Db,
): Promise<ItemWithCovers | null> {
  if (!blank(params.order_token)) {
    const orderId = verifiedOrderId(shop, params.order_token);
    if (orderId === null || blank(params.order_line_id)) return null;
    return db.item.findFirst({
      where: {
        shopId: shop.id,
        status: "active",
        orderId,
        orderLineId: String(params.order_line_id),
      },
      include: { covers: { orderBy: COVERS_ORDER } },
      orderBy: { unitIndex: "asc" },
    });
  }
  if (customerId === null || !resolver) return null;
  return resolver.resolve({
    itemId: params.item_id,
    orderId: params.order_id,
    orderLineId: params.order_line_id,
  });
}

function ticketAttributes(
  shop: Shop,
  params: IntakeParams,
  customerId: string | null,
): Prisma.RepairTicketUncheckedCreateInput {
  return {
    shopId: shop.id,
    shopifyCustomerId: customerId,
    customerEmail: params.customer_email ?? null,
    customerName: params.customer_name ?? null,
    customerPhone: params.customer_phone ?? null,
    customerAddress: addressHash(params.customer_address),
    productId: params.product_id ?? null,
    variantId: params.variant_id ?? null,
    productTitle: params.product_title ?? null,
    variantTitle: params.variant_title ?? null,
    orderNumber: params.order_number ?? null,
    orderDate: parseDate(params.order_date),
    noOrderHistory: castBoolean(params.no_order_history),
    description: params.description ?? null,
  };
}

/** A verified item's own product and order, over whatever the form said. */
function itemAttributes(item: ItemWithCovers | null): Partial<Prisma.RepairTicketUncheckedCreateInput> {
  if (!item) return {};
  const attrs: Partial<Prisma.RepairTicketUncheckedCreateInput> = {
    productId: item.productId,
    variantId: item.variantId,
    productTitle: item.productTitle,
    variantTitle: item.variantTitle,
    orderNumber: item.orderName,
    orderDate: item.purchasedAt ? utcDate(item.purchasedAt) : null,
  };
  return Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== null && v !== undefined));
}

function addressHash(address: IntakeParams["customer_address"]): Record<string, string> {
  if (!address) return {};
  const result: Record<string, string> = {};
  for (const key of ADDRESS_KEYS) {
    const value = address[key];
    if (!blank(value)) result[key] = String(value);
  }
  return result;
}

const utcDate = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/** Rails `Date.parse` (lenient); null when it isn't a date. */
function parseDate(value: unknown): Date | null {
  if (blank(value)) return null;
  const text = String(value).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    const date = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    return date.getUTCDate() === Number(iso[3]) ? date : null;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : utcDate(parsed);
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Rails `date.to_fs(:long)`: "%B %e, %Y", e.g. "October 16, 2026", "March  2, 2027". */
function railsLongDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, " ");
  return `${MONTHS[date.getUTCMonth()]} ${day}, ${date.getUTCFullYear()}`;
}

/** "Covered by 2-year Care until October 16, 2028 (free repairs)." Also logs £0 (fully covered) repairs. */
async function logCover(ticketId: number, cover: Cover, db: Db) {
  await createTicketActivity(
    {
      repairTicketId: ticketId,
      activityType: "system",
      author: "system",
      body: `Covered by ${coverName(cover)} until ${railsLongDate(cover.endsAt)} (${coverOutcomeLabel(cover).toLowerCase()}).`,
    },
    db,
  );
}

function maxImages(shop: Shop): number {
  const intake = settingsOf(shop).intake as Record<string, unknown> | undefined;
  const value = parseInt(String(intake?.max_images ?? DEFAULT_MAX_IMAGES), 10);
  return Number.isNaN(value) ? DEFAULT_MAX_IMAGES : value;
}

function isUpload(value: unknown): value is IntakeUpload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as IntakeUpload).arrayBuffer === "function" &&
    typeof (value as IntakeUpload).name === "string"
  );
}

function safeFilename(name: string): string {
  const cleaned = name.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "").slice(-100);
  return cleaned || "photo";
}

/**
 * Best effort: a rejected file (not really a JPEG/PNG/WebP/HEIC photo, too
 * big) doesn't fail the ticket.
 */
async function attachImages(
  shop: Shop,
  ticket: RepairTicket,
  images: unknown[],
  storage: FileStorage,
  db: Db,
  logger: Pick<Console, "error">,
) {
  const uploads = images.filter((image) => !blank(image)).slice(0, maxImages(shop));
  for (const upload of uploads) {
    if (!isUpload(upload) || upload.size === 0 || upload.size > MAX_BYTES) continue;
    const filename = safeFilename(upload.name);
    const storageKey = `shops/${shop.id}/tickets/${ticket.id}/${randomUUID()}-${filename}`;
    try {
      const body = await upload.arrayBuffer();
      // The real type from the file's bytes, not the declared one.
      const contentType = sniffImageType(body);
      if (!contentType) continue;
      const meta = { storageKey, contentType, byteSize: upload.size, filename };
      if (!validateTicketImage(meta).isEmpty) continue;
      await storage.put(storageKey, body, { contentType });
      await createTicketImage({ repairTicketId: ticket.id, ...meta }, db);
    } catch (error) {
      logger.error(`[repairs/intake] photo for ticket ${ticket.id} not saved:`, error);
    }
  }
}

/** Outbound webhook ("submitted") and the repair_submitted notification. Never fails the intake. */
async function announce(
  shop: Shop,
  ticket: RepairTicket,
  options: IntakeOptions,
  logger: Pick<Console, "error">,
) {
  try {
    const url = settingsOf(shop).webhook_url;
    await emitOutboundWebhook(
      typeof url === "string" ? url : null,
      { shopId: String(shop.id), ticketId: String(ticket.id), event: "submitted" },
      options.enqueue,
    );
  } catch (error) {
    logger.error(`[repairs/intake] webhook for ticket ${ticket.id} not queued:`, error);
  }
  if (!options.notifications) return;
  try {
    const settings = await loadNotificationSettings(shop.shopifyDomain, options.db ?? prisma);
    if (!settings) return;
    await emitNotification(
      "repair_submitted",
      {
        settings,
        recipient: {
          customerId: ticket.shopifyCustomerId,
          email: ticket.customerEmail,
          name: ticket.customerName,
        },
        data: {
          ticketId: ticket.id,
          productTitle: ticket.productTitle ?? "",
          customerName: ticket.customerName,
          customerEmail: ticket.customerEmail,
          description: ticket.description,
        },
      },
      options.notifications,
    );
  } catch (error) {
    logger.error(`[repairs/intake] notification for ticket ${ticket.id} not emitted:`, error);
  }
}

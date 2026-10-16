/**
 * GDPR `customers/redact`: strips one customer's personal data from a shop
 * while keeping the rows, so the merchant's repair history, cover, quote
 * totals and trade-in credit stay intact. Port of Repairs::CustomerRedactor,
 * extended to every place v2 keeps personal data:
 *
 *   repair tickets       name, email, phone, address, Shopify id, description;
 *                        photos (rows + stored files); the stored postage
 *                        slip (it prints the name and address); free-text activity
 *                        bodies (notes, quote decisions, anything the customer
 *                        wrote); quote decline reasons
 *   items                name, email, Shopify id, properties; the
 *                        registration's proof file and review note
 *   trade-ins            name, email, Shopify id, description, staff note,
 *                        photos (stored files too)
 *   notification log     payloads addressed to the customer (pending ones are
 *                        skipped so nothing is sent afterwards)
 *
 * Idempotent: running it again finds nothing left to
 * strip (stored-file deletes ignore missing files).
 */
import type { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import { getStorage, type FileStorage } from "../../lib/storage.server";
import { jsonArray } from "../../models/validation.server";
import {
  itemWhere,
  matchingDeliveryIds,
  ticketWhere,
  tradeInWhere,
  type CustomerRef,
} from "./customer-match.server";

export const REDACTED = "[redacted]";
/** Activity types whose bodies can hold what a person wrote. */
const FREE_TEXT_ACTIVITIES = ["note", "quote_decision"];

export interface RedactionSummary {
  tickets: number;
  items: number;
  tradeIns: number;
  deliveries: number;
  files: number;
}

export async function redactCustomer(
  shopId: number,
  ref: CustomerRef,
  {
    db = prisma,
    storage = getStorage(),
    logger = console,
  }: { db?: typeof prisma; storage?: FileStorage; logger?: Pick<Console, "warn"> } = {},
): Promise<RedactionSummary> {
  const summary: RedactionSummary = { tickets: 0, items: 0, tradeIns: 0, deliveries: 0, files: 0 };
  const keys: string[] = [];

  const tickets = await db.repairTicket.findMany({
    where: ticketWhere(shopId, ref),
    select: { id: true, postageSlipKey: true },
  });
  for (const { id, postageSlipKey } of tickets) {
    if (postageSlipKey) keys.push(postageSlipKey);
    await db.$transaction(async (tx) => {
      const images = await tx.ticketImage.findMany({ where: { repairTicketId: id } });
      keys.push(...images.flatMap((image) => (image.storageKey ? [image.storageKey] : [])));
      await tx.ticketImage.deleteMany({ where: { repairTicketId: id } });
      await tx.repairTicket.update({
        where: { id },
        data: {
          shopifyCustomerId: null,
          customerName: null,
          customerEmail: null,
          customerPhone: null,
          customerAddress: {},
          description: REDACTED,
          postageSlipKey: null,
          postageSlipDigest: null,
        },
      });
      await tx.ticketActivity.updateMany({
        where: {
          repairTicketId: id,
          OR: [{ activityType: { in: FREE_TEXT_ACTIVITIES } }, { author: "customer" }],
        },
        data: { body: REDACTED },
      });
      await tx.quotation.updateMany({
        where: { repairTicketId: id, decisionReason: { not: null } },
        data: { decisionReason: REDACTED },
      });
      await tx.ticketActivity.create({
        data: {
          repairTicketId: id,
          activityType: "system",
          author: "system",
          body: "Customer data redacted on request.",
        },
      });
    });
    summary.tickets++;
  }

  const items = await db.item.findMany({ where: itemWhere(shopId, ref), include: { registration: true } });
  for (const item of items) {
    await db.$transaction(async (tx) => {
      if (item.registration) {
        if (item.registration.proofKey) keys.push(item.registration.proofKey);
        await tx.registration.update({
          where: { id: item.registration.id },
          data: {
            proofKey: null,
            proofFilename: null,
            proofContentType: null,
            proofByteSize: null,
            reviewNote: null,
          },
        });
      }
      await tx.item.update({
        where: { id: item.id },
        data: { shopifyCustomerId: null, customerName: null, customerEmail: null, properties: {} },
      });
    });
    summary.items++;
  }

  const tradeIns = await db.tradeIn.findMany({ where: tradeInWhere(shopId, ref) });
  for (const tradeIn of tradeIns) {
    for (const photo of jsonArray(tradeIn.photos)) {
      const key = (photo as { key?: unknown })?.key;
      if (typeof key === "string" && key) keys.push(key);
    }
    await db.tradeIn.update({
      where: { id: tradeIn.id },
      data: {
        shopifyCustomerId: null,
        customerName: null,
        customerEmail: null,
        description: REDACTED,
        staffNote: null,
        photos: [] as Prisma.InputJsonValue,
      },
    });
    summary.tradeIns++;
  }

  const deliveryIds = await matchingDeliveryIds(db, shopId, ref);
  if (deliveryIds.length) {
    await db.notificationDelivery.updateMany({
      where: { id: { in: deliveryIds }, status: "pending" },
      data: { status: "skipped", error: "Customer data redacted" },
    });
    await db.notificationDelivery.updateMany({
      where: { id: { in: deliveryIds } },
      data: { payload: { redacted: true } },
    });
    summary.deliveries = deliveryIds.length;
  }

  // Files last: the rows no longer point at them, so a failure here only
  // leaves an unreachable blob; it's logged for a manual sweep.
  for (const key of keys) {
    try {
      await storage.delete(key);
      summary.files++;
    } catch (error) {
      logger.warn(`[gdpr/redact] couldn't delete stored file ${key}: ${String(error)}`);
    }
  }
  return summary;
}

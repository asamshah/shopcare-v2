/**
 * One event sent to one integration (Shopify Flow or Klaviyo), kept so
 * merchants can see what went out and what failed, and (v2) as the
 * idempotency record: a unique (shop, channel, idempotencyKey) stops
 * duplicates. Port of NotificationDelivery (docs/PORTING.md > Notifications). The notification service reads and writes these rows
 * through PrismaNotificationStore (app/services/notifications/prisma-store.server.ts).
 */
import type { NotificationDelivery, Prisma } from "@prisma/client";
import prisma from "../db.server";
import type { Db } from "../lib/db-lock.server";
import { assertValid, Errors, validateInclusion, validatePresence } from "./validation.server";

export const CHANNELS = ["flow", "klaviyo"] as const;
export type NotificationChannel = (typeof CHANNELS)[number];
export const DELIVERY_STATUSES = ["pending", "sent", "skipped", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export function validateNotificationDelivery(
  d: Pick<Prisma.NotificationDeliveryUncheckedCreateInput, "event" | "channel" | "status">,
): Errors {
  const errors = new Errors();
  validatePresence(errors, "event", d.event);
  validateInclusion(errors, "channel", d.channel, CHANNELS);
  validateInclusion(errors, "status", d.status ?? "pending", DELIVERY_STATUSES);
  return errors;
}

export async function createNotificationDelivery(
  data: Prisma.NotificationDeliveryUncheckedCreateInput,
  db: Db = prisma,
): Promise<NotificationDelivery> {
  assertValid("NotificationDelivery", validateNotificationDelivery(data));
  return db.notificationDelivery.create({ data });
}

export const RECENT_ORDER: Prisma.NotificationDeliveryOrderByWithRelationInput[] = [
  { createdAt: "desc" },
  { id: "desc" },
];

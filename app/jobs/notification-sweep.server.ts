/**
 * Hourly safety net for notifications: a delivery claimed but never enqueued
 * (the enqueue failed after the row was written) or whose background run was
 * lost stays `pending`. This re-enqueues pending deliveries older than
 * STALE_MINUTES and younger than MAX_AGE_HOURS; the notification job is
 * idempotent (it only sends a pending delivery, and the provider drops a
 * repeated idempotency key), so a duplicate enqueue sends nothing twice.
 * Deliveries that keep failing are marked failed by the job after its
 * attempts run out.
 */
import prisma from "../db.server";
import type { JobPayload } from "./registry.server";

export const STALE_MINUTES = 15;
export const MAX_AGE_HOURS = 48;

export async function sweepPendingNotifications({
  db = prisma,
  now = new Date(),
  enqueue,
}: {
  db?: typeof prisma;
  now?: Date;
  enqueue?: (name: "notification", payload: JobPayload) => Promise<void>;
} = {}): Promise<number> {
  const stale = await db.notificationDelivery.findMany({
    where: {
      status: "pending",
      updatedAt: { lt: new Date(now.getTime() - STALE_MINUTES * 60_000) },
      createdAt: { gt: new Date(now.getTime() - MAX_AGE_HOURS * 3_600_000) },
    },
    select: { id: true },
    orderBy: { id: "asc" },
    take: 500,
  });
  const run = enqueue ?? (await import("../lib/background.server")).enqueue;
  for (const { id } of stale) await run("notification", { deliveryId: String(id) });
  return stale.length;
}

export async function notificationSweepJob(): Promise<void> {
  const count = await sweepPendingNotifications();
  console.info(`[job:notification-sweep] re-enqueued ${count} pending deliveries`);
}

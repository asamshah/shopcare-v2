/**
 * `notify(shopDomain, event, …)`: what services call where Rails called
 * `Notifications::Dispatcher.new(shop).emit(…)`. Loads the shop's current
 * notification settings and emits through `emitNotification` (one delivery
 * per channel, idempotent per event + record, enqueued for the background
 * job). A shop that is gone or uninstalled gets nothing.
 *
 * Emitting never breaks the caller's work (a paid quote is still paid when the
 * staff alert can't be queued): failures are logged, and a delivery that was
 * claimed but never enqueued is picked up by the hourly notification sweep
 * (app/jobs/notification-sweep.server.ts).
 */
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import {
  emitNotification,
  getNotificationDeps,
  type NotificationDeps,
} from "../notifications.server";
import type { EventData, EventName } from "./events.server";
import { loadNotificationSettings } from "./shop-settings.server";
import type { DeliveryRecipient, NotificationDelivery } from "./store.server";

export interface NotifyOptions {
  db?: Db;
  deps?: Pick<NotificationDeps, "store" | "enqueue">;
  logger?: Pick<Console, "error">;
}

export async function notify<E extends EventName>(
  shopDomain: string,
  event: E,
  recipient: DeliveryRecipient,
  data: EventData[E],
  { db = prisma, deps, logger = console }: NotifyOptions = {},
): Promise<NotificationDelivery[]> {
  try {
    const settings = await loadNotificationSettings(shopDomain, db);
    if (!settings) return [];
    return await emitNotification(
      event,
      { settings, recipient, data },
      deps ?? getNotificationDeps(),
    );
  } catch (error) {
    logger.error(`[notify] ${event} for ${shopDomain} failed`, error);
    return [];
  }
}

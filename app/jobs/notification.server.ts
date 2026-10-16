import type { JobPayload } from "./registry.server";
import {
  deliverNotification,
  getNotificationDeps,
} from "../services/notifications.server";

/**
 * Sends one notification delivery (email, staff email, Flow trigger or
 * Klaviyo event). Ported from Rails NotificationJob. Enqueued by
 * `emitNotification()` with `{ deliveryId }`; a retryable failure throws so the
 * background function retries it (attempts are counted on the delivery).
 */
export async function notificationJob(payload: JobPayload): Promise<void> {
  const { deliveryId } = payload;
  if (typeof deliveryId !== "string" && typeof deliveryId !== "number") {
    console.error("[job:notification] missing deliveryId", payload);
    return;
  }
  await deliverNotification(String(deliveryId), getNotificationDeps());
}

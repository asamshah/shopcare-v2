/**
 * Notifications: the optional Shopify Flow and Klaviyo integrations. Ported
 * from Rails Notifications::Dispatcher + NotificationJob.
 *
 * ShopCare sends no email of its own: Shopify does (draft-order invoice,
 * Order confirmation snippet, Shipping confirmation; docs/PORTING.md →
 * Notifications). Events go to Flow (when the merchant turns it on) and
 * Klaviyo (when a key is saved), so merchants can build their own staff and
 * customer emails on them.
 *
 * Two halves:
 *
 *   emitNotification()   called from requests and webhook jobs. Works out the
 *                        channels (Flow on, Klaviyo key), claims one delivery
 *                        per channel under the idempotency key
 *                        `<event>:<record>`, and enqueues the "notification"
 *                        job for each new one. Never sends.
 *
 *   deliverNotification() the "notification" background job. Loads the
 *                        delivery and the shop's current settings and fires
 *                        the Flow trigger or Klaviyo event. A retryable
 *                        failure is rethrown so the background function
 *                        retries; after `maxAttempts`, or on a permanent
 *                        error, the delivery is marked failed.
 *
 * Dependencies are passed in (store, settings loader, Admin GraphQL client),
 * so everything here runs in tests without a database; the job uses the
 * production wiring by default (getNotificationDeps).
 */
import { DeliveryError } from "./notifications/delivery-error.server";
import {
  EVENTS,
  type Channel,
  type EventData,
  type EventName,
} from "./notifications/events.server";
import type { AdminGraphqlClient } from "../shopify/graphql.server";
import { FlowClient } from "./notifications/flow-client.server";
import { KlaviyoClient } from "./notifications/klaviyo-client.server";
import { productionNotificationDeps } from "./notifications/production-deps.server";
import type { ShopNotificationSettings } from "./notifications/settings.server";
import type {
  DeliveryRecipient,
  NotificationDelivery,
  NotificationStore,
} from "./notifications/store.server";

export const DEFAULT_MAX_ATTEMPTS = 3;

export interface NotificationDeps {
  store: NotificationStore;
  /** The shop's current settings, or null once the shop is gone (uninstalled). */
  loadSettings(shopId: string): Promise<ShopNotificationSettings | null>;
  /** An Admin GraphQL client for the shop (offline session), for Flow triggers. */
  adminClient(shopId: string): Promise<AdminGraphqlClient>;
  /** For the Klaviyo client (tests pass a fake). */
  fetch?: typeof fetch;
  /** Defaults to app/lib/background.server.ts `enqueue`. */
  enqueue?: (
    job: "notification",
    payload: { deliveryId: string },
  ) => Promise<void>;
  maxAttempts?: number;
}

// ---------------------------------------------------------------------------
// Wiring

let configured: NotificationDeps | undefined;

/**
 * Overrides the dependencies the "notification" job uses (tests). undefined
 * goes back to the default.
 */
export function setNotificationDeps(deps: NotificationDeps | undefined) {
  configured = deps;
}

/**
 * The job's dependencies: whatever setNotificationDeps() set, else the
 * production wiring (Prisma store, Shop-row settings, Shopify clients; notifications/production-deps.server.ts). Under Vitest there is no
 * default, so a test can't send through the real database by accident.
 */
export function getNotificationDeps(): NotificationDeps {
  if (configured) return configured;
  if (process.env.VITEST) {
    throw new Error(
      "Notifications aren't wired up in tests: call setNotificationDeps().",
    );
  }
  configured = productionNotificationDeps();
  return configured;
}

async function enqueueWith(
  deps: Pick<NotificationDeps, "enqueue">,
  deliveryId: string,
) {
  if (deps.enqueue) return deps.enqueue("notification", { deliveryId });
  // Imported lazily: background.server → jobs registry → this module.
  const { enqueue } = await import("../lib/background.server");
  return enqueue("notification", { deliveryId });
}

// ---------------------------------------------------------------------------
// Emit

export interface EmitInput<E extends EventName> {
  settings: ShopNotificationSettings;
  /** The customer the event is about (also the Flow customer reference). */
  recipient: DeliveryRecipient;
  data: EventData[E];
}

export function idempotencyKey<E extends EventName>(
  event: E,
  data: EventData[E],
): string {
  return `${event}:${EVENTS[event].recordKey(data)}`;
}

/** The channels an event goes to for this shop right now. */
export function channelsFor<E extends EventName>(
  event: E,
  settings: ShopNotificationSettings,
): Channel[] {
  const def = EVENTS[event];
  const channels: Channel[] = [];
  if (def.flowHandle && settings.flowEnabled) channels.push("flow");
  if (def.klaviyoMetric && settings.klaviyoApiKey) channels.push("klaviyo");
  return channels;
}

/**
 * Records one delivery per channel and enqueues each new one. A repeat of the
 * same event (duplicate webhook, retried request) finds the existing rows and
 * enqueues nothing.
 */
export async function emitNotification<E extends EventName>(
  event: E,
  { settings, recipient, data }: EmitInput<E>,
  deps: Pick<NotificationDeps, "store" | "enqueue">,
): Promise<NotificationDelivery[]> {
  if (!Object.hasOwn(EVENTS, event))
    throw new Error(`Unknown notification ${event}`);

  const key = idempotencyKey(event, data);
  const deliveries: NotificationDelivery[] = [];
  for (const channel of channelsFor(event, settings)) {
    const { delivery, created } = await deps.store.claim({
      shopId: settings.shopId,
      event,
      channel,
      idempotencyKey: key,
      payload: { recipient, data },
    });
    if (created) await enqueueWith(deps, delivery.id);
    deliveries.push(delivery);
  }
  return deliveries;
}

// ---------------------------------------------------------------------------
// Deliver

type Outcome = { sent: true } | { sent: false; reason: string };

const skip = (reason: string): Outcome => ({ sent: false, reason });

/** The "notification" job: sends one delivery. Safe to run more than once. */
export async function deliverNotification(
  deliveryId: string,
  deps: NotificationDeps,
): Promise<void> {
  const delivery = await deps.store.find(deliveryId);
  if (!delivery || delivery.status !== "pending") return;

  let outcome: Outcome;
  try {
    const settings = await deps.loadSettings(delivery.shopId);
    outcome = settings
      ? await deliverTo(delivery, settings, deps)
      : skip("The shop no longer has ShopCare installed");
  } catch (error) {
    const retryable = error instanceof DeliveryError ? error.retryable : true;
    const max = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const final = !retryable || delivery.attempts + 1 >= max;
    const message = error instanceof Error ? error.message : String(error);
    await deps.store.markFailed(delivery.id, message, { final });
    console.warn(
      `[notifications] ${delivery.event}/${delivery.channel} #${delivery.id} failed${final ? "" : ", will retry"}: ${message}`,
    );
    if (!final) throw error;
    return;
  }

  if (outcome.sent) {
    await deps.store.markSent(delivery.id);
  } else {
    await deps.store.markSkipped(delivery.id, outcome.reason);
    console.info(
      `[notifications] ${delivery.event}/${delivery.channel} #${delivery.id} skipped: ${outcome.reason}`,
    );
  }
}

async function deliverTo(
  delivery: NotificationDelivery,
  settings: ShopNotificationSettings,
  deps: NotificationDeps,
): Promise<Outcome> {
  const def = EVENTS[delivery.event];
  const { recipient, data } = delivery.payload;
  // `fields` is typed per event; the delivery's event and data were stored together.
  const fields = (def.fields as (d: unknown) => ReturnType<typeof def.fields>)(
    data,
  );

  switch (delivery.channel) {
    case "flow": {
      if (!def.flowHandle) return skip("No Flow trigger for this event");
      if (!settings.flowEnabled) return skip("Shopify Flow is turned off");
      if (!def.staffAlert && !recipient.customerId)
        return skip("No Shopify customer to attach the trigger to");
      const client = await deps.adminClient(delivery.shopId);
      await new FlowClient(client).trigger(def.flowHandle, {
        customerId: def.staffAlert ? null : recipient.customerId,
        fields,
      });
      return { sent: true };
    }
    case "klaviyo": {
      if (!def.klaviyoMetric) return skip("No Klaviyo metric for this event");
      if (!recipient.email) return skip("No customer email");
      if (!settings.klaviyoApiKey) return skip("Klaviyo isn't connected");
      await new KlaviyoClient(settings.klaviyoApiKey, deps.fetch).track({
        metric: def.klaviyoMetric,
        email: recipient.email,
        properties: fields,
        uniqueId: `shopcare-${delivery.id}`,
      });
      return { sent: true };
    }
  }
}

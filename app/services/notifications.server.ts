/**
 * Notifications: ShopCare's own customer and staff emails, plus the optional
 * Shopify Flow and Klaviyo integrations. Ported from Rails
 * Notifications::Dispatcher + NotificationJob, redesigned per "Notifications
 * (v2 design)" in docs/PORTING.md.
 *
 * Two halves:
 *
 *   emitNotification()   called from requests and webhook jobs. Works out the
 *                        channels (per-email toggles, Flow on, Klaviyo key),
 *                        claims one delivery per channel under the
 *                        idempotency key `<event>:<record>`, and enqueues the
 *                        "notification" job for each new one. Never sends.
 *
 *   deliverNotification() the "notification" background job. Loads the
 *                        delivery and the shop's current settings, re-checks
 *                        the toggle, checks marketing consent at send time,
 *                        renders and sends. A retryable failure is rethrown so
 *                        the background function retries; after
 *                        `maxAttempts`, or on a permanent error, the delivery
 *                        is marked failed.
 *
 * Dependencies are passed in (store, settings loader, consent checker, Admin
 * GraphQL client), so everything here runs in tests without a database; the
 * job uses the production wiring by default (getNotificationDeps).
 */
import {
  EmailDeliveryError,
  sendEmail as defaultSendEmail,
  type EmailMessage,
} from "./email.server";
import { DeliveryError } from "./notifications/delivery-error.server";
import {
  EVENTS,
  MARKETING_EMAILS,
  customerEmailFor,
  type Channel,
  type EmailKind,
  type EventData,
  type EventName,
} from "./notifications/events.server";
import type { AdminGraphqlClient } from "../shopify/graphql.server";
import { FlowClient } from "./notifications/flow-client.server";
import { KlaviyoClient } from "./notifications/klaviyo-client.server";
import { productionNotificationDeps } from "./notifications/production-deps.server";
import {
  isEmailEnabled,
  type ShopNotificationSettings,
} from "./notifications/settings.server";
import type {
  DeliveryRecipient,
  NotificationDelivery,
  NotificationStore,
} from "./notifications/store.server";
import { renderEmail, type EmailData } from "./notifications/templates.server";

export const DEFAULT_MAX_ATTEMPTS = 3;

export interface NotificationDeps {
  store: NotificationStore;
  /** The shop's current settings, or null once the shop is gone (uninstalled). */
  loadSettings(shopId: string): Promise<ShopNotificationSettings | null>;
  /** Marketing consent at send time; see consent.server.ts for the Shopify-backed one. */
  hasEmailMarketingConsent(
    recipient: DeliveryRecipient,
    context: { shopId: string },
  ): Promise<boolean>;
  /** An Admin GraphQL client for the shop (offline session), for Flow triggers. */
  adminClient(shopId: string): Promise<AdminGraphqlClient>;
  /**
   * The one-click unsubscribe URL for a marketing email. Without one the
   * marketing email is skipped.
   */
  unsubscribeUrl?(
    shopId: string,
    recipient: DeliveryRecipient,
  ): string | null | undefined;
  sendEmail?: (message: EmailMessage) => Promise<{ id: string }>;
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
 * production wiring (Prisma store, Shop-row settings, Shopify consent and
 * clients; notifications/production-deps.server.ts). Under Vitest there is no
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
  data: EventData[E],
  settings: ShopNotificationSettings,
): Channel[] {
  const def = EVENTS[event];
  const channels: Channel[] = [];
  const customerEmail = customerEmailFor(event, data);
  if (customerEmail && isEmailEnabled(settings, customerEmail))
    channels.push("email");
  if (def.staffEmail && isEmailEnabled(settings, def.staffEmail))
    channels.push("staff_email");
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
  for (const channel of channelsFor(event, data, settings)) {
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

type Outcome =
  { sent: true; providerMessageId?: string } | { sent: false; reason: string };

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
    const retryable =
      error instanceof EmailDeliveryError || error instanceof DeliveryError
        ? error.retryable
        : true;
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
    await deps.store.markSent(delivery.id, outcome.providerMessageId);
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
    case "email": {
      const kind = customerEmailFor(delivery.event, data);
      if (!kind) return skip("No customer email for this event");
      return sendShopEmail(delivery, settings, deps, kind, recipient.email);
    }
    case "staff_email": {
      if (!def.staffEmail) return skip("No staff alert for this event");
      return sendShopEmail(
        delivery,
        settings,
        deps,
        def.staffEmail,
        settings.staffEmail,
      );
    }
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

async function sendShopEmail(
  delivery: NotificationDelivery,
  settings: ShopNotificationSettings,
  deps: NotificationDeps,
  kind: EmailKind,
  to: string | null | undefined,
): Promise<Outcome> {
  // The merchant may have switched it off after the event was emitted.
  if (!isEmailEnabled(settings, kind)) return skip("Turned off in Settings");
  if (!to)
    return skip(
      delivery.channel === "staff_email"
        ? "No staff alert address in Settings"
        : "No customer email",
    );

  const { recipient } = delivery.payload;
  let unsubscribeUrl: string | null | undefined;
  const headers: Record<string, string> = {};
  if (MARKETING_EMAILS.includes(kind)) {
    if (!recipient.customerId)
      return skip("Guest customer: no email marketing consent");
    const consent = await deps.hasEmailMarketingConsent(recipient, {
      shopId: delivery.shopId,
    });
    if (!consent) return skip("Customer isn't subscribed to email marketing");
    unsubscribeUrl = deps.unsubscribeUrl?.(delivery.shopId, recipient);
    if (!unsubscribeUrl) return skip("No unsubscribe link available");
    headers["List-Unsubscribe"] = `<${unsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  const content = renderEmail(
    kind,
    delivery.payload.data as EmailData[typeof kind],
    { settings, unsubscribeUrl },
  );
  // Staff can reply straight to the customer; customers reply to the shop.
  const customerEmail = (
    delivery.payload.data as { customerEmail?: string | null }
  ).customerEmail;
  const replyTo =
    delivery.channel === "staff_email"
      ? customerEmail || settings.supportEmail
      : settings.supportEmail;

  const send = deps.sendEmail ?? defaultSendEmail;
  const result = await send({
    shopId: delivery.shopId,
    // "Notify staff at" may list several addresses.
    to: to
      .split(/[,;]/)
      .map((address) => address.trim())
      .filter(Boolean),
    ...content,
    replyTo: replyTo || undefined,
    fromName: `${settings.shopName} via ShopCare`,
    tags: { event: delivery.event, email: kind },
    // Provider idempotency keys are account-wide, so scope them to shop and channel.
    idempotencyKey: `${delivery.shopId}:${delivery.channel}:${delivery.idempotencyKey}`,
    headers: Object.keys(headers).length ? headers : undefined,
  });
  return { sent: true, providerMessageId: result.id };
}

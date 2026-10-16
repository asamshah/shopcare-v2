import type { JobPayload } from "./registry.server";
import {
  buildRepairEventPayload,
  type EventPayloadQuotation,
  type EventPayloadTicket,
} from "../services/repairs/event-payload.server";
import {
  deliverWebhook,
  type WebhookDeliveryOptions,
} from "../services/repairs/webhook-delivery.server";

/**
 * Delivers a repair-ticket event to the merchant's outbound webhook (Settings
 * → Integrations). Ported from Rails OutboundWebhookJob.
 *
 * Callers use `emitOutboundWebhook()`, which enqueues only when the shop has a
 * webhook URL. The job re-reads the URL, so clearing it after the enqueue
 * stops the delivery.
 */

export interface OutboundWebhookContext {
  url: string | null | undefined;
  secret?: string | null;
  shopDomain: string;
  ticket: EventPayloadTicket;
  quotation?: EventPayloadQuotation | null;
}

export interface OutboundWebhookDeps {
  /** The shop's webhook settings plus the ticket; null if the shop or ticket is gone. */
  loadContext(
    shopId: string,
    ticketId: string,
  ): Promise<OutboundWebhookContext | null>;
  delivery?: Omit<WebhookDeliveryOptions, "secret">;
}

let configured: OutboundWebhookDeps | undefined;

/** Overrides the job's dependencies (tests); undefined goes back to the default. */
export function setOutboundWebhookDeps(deps: OutboundWebhookDeps | undefined) {
  configured = deps;
}

/**
 * The job's dependencies: whatever was set, else (outside Vitest) the Prisma
 * loader in app/services/repairs/outbound-webhook-context.server.ts.
 */
async function outboundWebhookDeps(): Promise<OutboundWebhookDeps> {
  if (configured) return configured;
  if (process.env.VITEST)
    throw new Error(
      "Outbound webhooks aren't wired up in tests: call setOutboundWebhookDeps().",
    );
  const { loadOutboundWebhookContext } = await import(
    "../services/repairs/outbound-webhook-context.server"
  );
  configured = { loadContext: (shopId, ticketId) => loadOutboundWebhookContext(shopId, ticketId) };
  return configured;
}

export interface OutboundWebhookJobPayload {
  shopId: string;
  ticketId: string;
  event: string;
  detail?: string | null;
}

export async function emitOutboundWebhook(
  webhookUrl: string | null | undefined,
  job: OutboundWebhookJobPayload,
  enqueue?: (name: "outbound-webhook", payload: JobPayload) => Promise<void>,
): Promise<boolean> {
  if (!webhookUrl?.trim()) return false;
  const run = enqueue ?? (await import("../lib/background.server")).enqueue;
  await run("outbound-webhook", { ...job });
  return true;
}

export async function performOutboundWebhook(
  { shopId, ticketId, event, detail }: OutboundWebhookJobPayload,
  deps: OutboundWebhookDeps,
): Promise<{ status: number } | null> {
  const context = await deps.loadContext(String(shopId), String(ticketId));
  if (!context?.url?.trim()) return null;

  const payload = buildRepairEventPayload({
    shopDomain: context.shopDomain,
    ticket: context.ticket,
    quotation: context.quotation,
    event,
    detail,
  });
  return deliverWebhook(context.url, payload, {
    ...deps.delivery,
    secret: context.secret,
  });
}

export async function outboundWebhookJob(payload: JobPayload): Promise<void> {
  const { shopId, ticketId, event, detail } = payload;
  if (
    (typeof shopId !== "string" && typeof shopId !== "number") ||
    (typeof ticketId !== "string" && typeof ticketId !== "number") ||
    typeof event !== "string"
  ) {
    console.error("[job:outbound-webhook] invalid payload", payload);
    return;
  }
  const deps = await outboundWebhookDeps();
  await performOutboundWebhook(
    {
      shopId: String(shopId),
      ticketId: String(ticketId),
      event,
      detail: typeof detail === "string" ? detail : null,
    },
    deps,
  );
}

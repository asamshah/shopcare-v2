import type { JobPayload } from "./registry.server";

/**
 * Slow work for a Shopify webhook, after the route has acked it.
 *
 * The webhook route checks the HMAC, does anything quick inline, and hands the
 * payload here (see docs/BACKGROUND-WORK.md). Each topic's handler is ported
 * from the Rails job of the same name (OrdersPaidJob, RefundsCreateJob, …).
 * Until a handler exists, the event is logged loudly so it isn't missed.
 */
type TopicHandler = (shop: string, payload: unknown) => Promise<void>;

const handlers: Record<string, TopicHandler> = {
  // "ORDERS_PAID": ordersPaid,        // Rails OrdersPaidJob → Repairs::PaymentProcessor
  // "REFUNDS_CREATE": refundsCreate,  // Rails RefundsCreateJob → Items::RefundProcessor
};

export async function webhookJob(job: JobPayload): Promise<void> {
  const { topic, shop, payload } = job as {
    topic: string;
    shop: string;
    payload: unknown;
  };
  const handler = handlers[topic];
  if (!handler) {
    console.warn(
      `[job:webhook] ${topic} for ${shop}: no handler ported yet, ignored`,
    );
    return;
  }
  await handler(shop, payload);
}

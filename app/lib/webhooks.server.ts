/**
 * The webhook pattern (docs/BACKGROUND-WORK.md): verify, ack fast, defer.
 *
 * Shopify expects a 2xx within 5 seconds and retries otherwise, so a route
 * checks the HMAC, does at most a quick inline step (a single DB write), and
 * hands anything slower (Admin API calls, emails, Flow triggers) to the
 * `webhook` background job. Duplicate deliveries happen, so handlers must be
 * idempotent; the X-Shopify-Webhook-Id header is passed along for dedupe.
 */
import { authenticate } from "../shopify.server";
import { enqueue } from "./background.server";

export async function ackAndEnqueue(request: Request): Promise<Response> {
  const { topic, shop, payload, webhookId } =
    await authenticate.webhook(request);
  await enqueue("webhook", { topic, shop, payload, webhookId });
  return new Response(null, { status: 200 });
}

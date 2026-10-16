import type { ActionFunctionArgs } from "react-router";
import { resendWebhook } from "../services/notifications/resend-webhook.server";

/**
 * POST /webhooks/email — Resend's event webhook (email.bounced,
 * email.complained), Svix-signed with RESEND_WEBHOOK_SECRET. Feeds the
 * suppression list; see app/services/notifications/resend-webhook.server.ts.
 */
export const action = async ({ request }: ActionFunctionArgs) => resendWebhook(request);

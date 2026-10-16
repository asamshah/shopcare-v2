import type { ActionFunctionArgs } from "react-router";
import { ackAndEnqueue } from "../lib/webhooks.server";

// Ack, then hand off to the `webhook` background job (app/jobs/webhook.server.ts).
export const action = async ({ request }: ActionFunctionArgs) =>
  ackAndEnqueue(request);

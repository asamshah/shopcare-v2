/**
 * Netlify Scheduled Function: hourly, hands the "notification-sweep" job
 * (app/jobs/notification-sweep.server.ts) to the background function, which
 * re-enqueues notification deliveries stuck in `pending` (an enqueue that
 * failed after the delivery was claimed). Runs on the published deploy only.
 */
import type { Config } from "@netlify/functions";
import { enqueue } from "../../app/lib/background.server";

export default async () => {
  await enqueue("notification-sweep", {});
};

export const config: Config = {
  schedule: "20 * * * *", // every hour at :20 UTC
};

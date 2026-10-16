/**
 * Netlify Scheduled Function, the template for daily jobs (Rails
 * ExpireQuotesJob and similar).
 *
 * Scheduled functions get 30 seconds and run only on the published deploy,
 * not on previews. Anything longer must be handed to the background function
 * with `enqueue()`, which is what this one does. Cron is in UTC.
 * https://docs.netlify.com/build/functions/scheduled-functions/
 */
import type { Config } from "@netlify/functions";
import { enqueue } from "../../app/lib/background.server";

export default async (req: Request) => {
  const { next_run } = (await req.json().catch(() => ({}))) as {
    next_run?: string;
  };
  await enqueue("example", {
    message: `daily run; next at ${next_run ?? "unknown"}`,
  });
};

export const config: Config = {
  schedule: "0 3 * * *", // 03:00 UTC daily
};

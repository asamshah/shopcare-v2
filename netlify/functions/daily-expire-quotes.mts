/**
 * Netlify Scheduled Function (Rails config/recurring.yml `expire_quotes`,
 * daily 3am): hands the "expire-quotes" job (app/jobs/expire-quotes.server.ts)
 * to the background function, which expires sent quotes left unpaid past
 * their validity. The review page and ticket view also expire an overdue
 * quote when opened, so nothing waits on this to be correct. Runs on the
 * published deploy only; cron is UTC.
 * https://docs.netlify.com/build/functions/scheduled-functions/
 */
import type { Config } from "@netlify/functions";
import { enqueue } from "../../app/lib/background.server";

export default async () => {
  await enqueue("expire-quotes", {});
};

export const config: Config = {
  schedule: "0 3 * * *", // 03:00 UTC daily
};

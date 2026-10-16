/**
 * Netlify Scheduled Function: daily housekeeping. Hands the "daily-prune" job
 * (app/jobs/daily-prune.server.ts) to the background function, which deletes
 * old App Proxy throttle counters (`proxy_throttles`) and expired shared-cache
 * entries (`cache_entries`). Runs on the published deploy only. Cron is UTC.
 */
import type { Config } from "@netlify/functions";
import { enqueue } from "../../app/lib/background.server";

export default async () => {
  await enqueue("daily-prune", {});
};

export const config: Config = {
  schedule: "15 3 * * *", // 03:15 UTC daily
};

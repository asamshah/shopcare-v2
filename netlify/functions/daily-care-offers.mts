/**
 * Netlify Scheduled Function: hands the "care-offers" job
 * (app/jobs/care-offers.server.ts) to the background function, which emits
 * the "Add Care to your purchase" offer for orders placed
 * `care_offer_delay_days` ago. Marketing consent is checked when each email
 * is sent. Runs on the published deploy only. Cron is UTC: 10:00, so the
 * emails land in the UK morning.
 */
import type { Config } from "@netlify/functions";
import { enqueue } from "../../app/lib/background.server";

export default async () => {
  await enqueue("care-offers", {});
};

export const config: Config = {
  schedule: "0 10 * * *",
};

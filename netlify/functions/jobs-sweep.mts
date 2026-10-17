/**
 * Netlify Scheduled Function: every 5 minutes, sends again the saved jobs
 * that are due (sweepJobs in app/lib/background.server.ts): failed runs past
 * their backoff, dispatches that never arrived, and runs that crashed or
 * timed out. It only queries and POSTs, well inside the 30 s limit. Runs on
 * the published deploy only.
 */
import type { Config } from "@netlify/functions";
import { sweepJobs } from "../../app/lib/background.server";
import { reportError } from "../../app/lib/errors.server";

export default async () => {
  try {
    const sent = await sweepJobs();
    if (sent) console.info(`[jobs-sweep] sent ${sent} jobs again`);
  } catch (error) {
    await reportError(error, { area: "jobs", step: "sweep" });
    throw error;
  }
};

export const config: Config = {
  schedule: "*/5 * * * *",
};

import type { JobPayload } from "./registry.server";

/**
 * A placeholder job with no domain logic. It shows the shape: validate the
 * payload, do the work, and throw to get a retry.
 */
export async function exampleJob(payload: JobPayload): Promise<void> {
  const message =
    typeof payload.message === "string" ? payload.message : "(none)";
  console.info(`[job:example] ${message}`);
}

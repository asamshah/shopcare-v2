/**
 * Background jobs: name → handler.
 *
 * Handlers are plain async functions of a JSON payload. They know nothing
 * about Netlify, so the same code runs:
 *   - in a Netlify Background Function (netlify/functions/jobs-background.mts)
 *     in production
 *   - in-process under `shopify app dev` and in tests (see dispatch in
 *     app/lib/background.server.ts)
 *
 * Handlers must be idempotent. Netlify retries a failed background invocation
 * twice (after 1 and 2 minutes), and Shopify can deliver a webhook more than
 * once. Domain jobs (Rails app/jobs/*) are added here as they're ported, see
 * docs/PORTING.md.
 */
import { exampleJob } from "./example.server";
import { webhookJob } from "./webhook.server";

export type JobPayload = Record<string, unknown>;
export type JobHandler = (payload: JobPayload) => Promise<void>;

export const jobs = {
  example: exampleJob,
  webhook: webhookJob,
} satisfies Record<string, JobHandler>;

export type JobName = keyof typeof jobs;

export function isJobName(name: unknown): name is JobName {
  return typeof name === "string" && Object.hasOwn(jobs, name);
}

export async function runJob(
  name: JobName,
  payload: JobPayload,
): Promise<void> {
  const started = Date.now();
  try {
    await jobs[name](payload);
    console.info(`[job] ${name} ok in ${Date.now() - started}ms`);
  } catch (error) {
    console.error(
      `[job] ${name} failed after ${Date.now() - started}ms`,
      error,
    );
    throw error;
  }
}

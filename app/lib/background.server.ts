/**
 * Hand work to a background job: `await enqueue("example", { … })`.
 *
 * Dispatch modes (BACKGROUND_DISPATCH):
 *   netlify  POST the job to the Netlify Background Function
 *            (/.netlify/functions/jobs-background). Netlify answers 202 at
 *            once and runs the job for up to 15 minutes, retrying on error.
 *   inline   Run the job in this process without awaiting it. Used for
 *            `shopify app dev`, where no Netlify Functions server runs.
 *   sync     Run the job and await it. Used in tests so assertions see the result.
 *
 * The background function URL is public, so every dispatch is signed with an
 * HMAC (key derived from APP_ENCRYPTION_KEY) and timestamped, and the function
 * rejects anything unsigned or more than 5 minutes old.
 */
import {
  isJobName,
  runJob,
  type JobName,
  type JobPayload,
} from "../jobs/registry.server";
import { derivedSecret, hmacHex, safeEqualHex } from "./signing.server";

export const SIGNATURE_HEADER = "x-shopcare-signature";
const MAX_AGE_SECONDS = 5 * 60;

type DispatchMode = "netlify" | "inline" | "sync";

function onNetlify(): boolean {
  return "Netlify" in globalThis || process.env.NETLIFY === "true";
}

export function dispatchMode(): DispatchMode {
  const mode = process.env.BACKGROUND_DISPATCH;
  if (mode === "netlify" || mode === "inline" || mode === "sync") return mode;
  if (process.env.VITEST) return "sync";
  return onNetlify() ? "netlify" : "inline";
}

function secret() {
  return derivedSecret("shopcare:background-jobs");
}

export function signJobBody(body: string, now = Date.now()): string {
  const ts = Math.floor(now / 1000);
  return `${ts}.${hmacHex(secret(), `${ts}.${body}`)}`;
}

export function verifyJobSignature(
  body: string,
  header: string | null,
  now = Date.now(),
): boolean {
  if (!header) return false;
  const [ts, sig] = header.split(".");
  const age = Math.floor(now / 1000) - Number(ts);
  if (!Number.isFinite(age) || age < -60 || age > MAX_AGE_SECONDS) return false;
  return safeEqualHex(sig ?? "", hmacHex(secret(), `${ts}.${body}`));
}

export interface JobEnvelope {
  job: JobName;
  payload: JobPayload;
}

export function parseEnvelope(body: string): JobEnvelope | null {
  try {
    const parsed = JSON.parse(body);
    if (
      !isJobName(parsed?.job) ||
      typeof parsed.payload !== "object" ||
      parsed.payload === null
    ) {
      return null;
    }
    return parsed as JobEnvelope;
  } catch {
    return null;
  }
}

function functionUrl(): string {
  const base =
    process.env.BACKGROUND_FUNCTIONS_URL ||
    process.env.SHOPIFY_APP_URL ||
    process.env.URL;
  if (!base)
    throw new Error(
      "Set SHOPIFY_APP_URL (or BACKGROUND_FUNCTIONS_URL) to dispatch jobs.",
    );
  return new URL("/.netlify/functions/jobs-background", base).toString();
}

export async function enqueue(
  job: JobName,
  payload: JobPayload,
): Promise<void> {
  const mode = dispatchMode();

  if (mode === "sync") {
    await runJob(job, payload);
    return;
  }

  if (mode === "inline") {
    // Fire and forget, like a real queue; errors are logged by runJob.
    void runJob(job, payload).catch(() => {});
    return;
  }

  const body = JSON.stringify({ job, payload } satisfies JobEnvelope);
  const response = await fetch(functionUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SIGNATURE_HEADER]: signJobBody(body),
    },
    body,
  });
  // 202 means Netlify accepted the invocation, not that the job succeeded.
  if (response.status !== 202) {
    throw new Error(
      `Background dispatch of ${job} failed: HTTP ${response.status}`,
    );
  }
}

/**
 * Netlify Background Function: runs one job from app/jobs/registry.server.ts.
 *
 * Netlify answers the caller with 202 straight away and gives this up to
 * 15 minutes. Callers use `enqueue()` from app/lib/background.server.ts,
 * which saves the job and sends its id, signed. Unsigned or stale requests
 * are dropped. If the job throws, Netlify retries after 1 minute and again
 * after 2; after that the sweep (jobs-sweep.mts) takes over.
 * https://docs.netlify.com/build/functions/background-functions/
 */
import type { Config } from "@netlify/functions";
import {
  parseEnvelope,
  runStoredJob,
  SIGNATURE_HEADER,
  verifyJobSignature,
} from "../../app/lib/background.server";
import { reportError } from "../../app/lib/errors.server";
import { runJob } from "../../app/jobs/registry.server";

export default async (req: Request) => {
  const body = await req.text();
  if (!verifyJobSignature(body, req.headers.get(SIGNATURE_HEADER))) {
    // Returning normally means no retry; a bad signature won't fix itself.
    console.warn("[jobs-background] rejected: bad or missing signature");
    return;
  }
  const envelope = parseEnvelope(body);
  if (!envelope) {
    console.warn("[jobs-background] rejected: malformed job envelope");
    return;
  }
  // Throwing here makes Netlify retry the invocation.
  if ("jobId" in envelope) {
    await runStoredJob(envelope.jobId);
    return;
  }
  // A dispatch from before jobs were saved: run it as sent.
  try {
    await runJob(envelope.job, envelope.payload);
  } catch (error) {
    await reportError(error, { area: "jobs", job: envelope.job });
    throw error;
  }
};

export const config: Config = {
  background: true,
};

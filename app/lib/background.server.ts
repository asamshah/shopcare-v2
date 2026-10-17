/**
 * Hand work to a background job: `await enqueue("example", { … })`.
 *
 * Every job is saved in the `jobs` table first (except in sync mode), so it
 * can't be lost: a dispatch that fails, a function that crashes or times out,
 * or a job that throws leaves the row behind, and the sweep
 * (netlify/functions/jobs-sweep.mts, every 5 minutes) sends it again with
 * backoff. A job is deleted when it succeeds and marked `failed` (and
 * reported) after MAX_ATTEMPTS. Only the row's id goes to the background
 * function, so payloads aren't bound by its 256 KB request limit.
 *
 * Dispatch modes (BACKGROUND_DISPATCH):
 *   netlify  Save the job, then POST its id to the Netlify Background Function
 *            (/.netlify/functions/jobs-background). Netlify answers 202 at
 *            once and runs it for up to 15 minutes. A failed POST is logged,
 *            not thrown: the sweep sends it.
 *   inline   Save the job and run it in this process without awaiting it.
 *            Used for `shopify app dev`, where no Netlify Functions run (and
 *            so no sweep: a failed job stays `pending`).
 *   sync     Run the job and await it, without saving it. Used in tests so
 *            assertions see the result.
 *
 * The background function URL is public, so every dispatch is signed with an
 * HMAC (key derived from APP_ENCRYPTION_KEY) and timestamped, and the function
 * rejects anything unsigned or more than 5 minutes old.
 */
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import {
  isJobName,
  runJob,
  type JobName,
  type JobPayload,
} from "../jobs/registry.server";
import { reportError } from "./errors.server";
import { derivedSecret, hmacHex, safeEqualHex } from "./signing.server";

export const SIGNATURE_HEADER = "x-shopcare-signature";
const MAX_AGE_SECONDS = 5 * 60;

/** Runs before a job is marked failed (Netlify's own retries count too). */
export const MAX_ATTEMPTS = 6;
/** Wait before the next run, by attempts so far (the last repeats). */
const BACKOFF_MINUTES = [1, 2, 10, 30, 120];
/** A running job not finished in this long crashed or timed out (Netlify stops at 15). */
export const STALE_RUNNING_MINUTES = 20;
/** A new pending job gets this long for its own dispatch before the sweep sends it. */
export const DISPATCH_GRACE_MINUTES = 2;
const SWEEP_BATCH = 50;

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

/** What the background function is sent: a saved job's id, or (older dispatches) the job itself. */
export type JobEnvelope = { jobId: number } | { job: JobName; payload: JobPayload };

export function parseEnvelope(body: string): JobEnvelope | null {
  try {
    const parsed = JSON.parse(body);
    if (Number.isSafeInteger(parsed?.jobId) && parsed.jobId > 0) {
      return { jobId: parsed.jobId };
    }
    if (
      !isJobName(parsed?.job) ||
      typeof parsed.payload !== "object" ||
      parsed.payload === null
    ) {
      return null;
    }
    return { job: parsed.job, payload: parsed.payload };
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

/**
 * Saves the job and starts it. Throws only if the job couldn't be saved (so
 * a webhook route answers 500 and Shopify delivers again).
 */
export async function enqueue(
  job: JobName,
  payload: JobPayload,
): Promise<void> {
  const mode = dispatchMode();

  if (mode === "sync") {
    await runJob(job, payload);
    return;
  }

  const { id } = await prisma.job.create({
    data: {
      name: job,
      payload: payload as Prisma.InputJsonValue,
      shopDomain: typeof payload.shop === "string" ? payload.shop : null,
    },
    select: { id: true },
  });

  if (mode === "inline") {
    // Fire and forget, like a real queue; errors are recorded on the row.
    void runStoredJob(id).catch(() => {});
    return;
  }
  await dispatchJob(id, job);
}

/** POSTs a saved job's id to the background function. Never throws: the sweep retries. */
export async function dispatchJob(id: number, name = "job"): Promise<boolean> {
  try {
    const body = JSON.stringify({ jobId: id });
    const response = await fetch(functionUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signJobBody(body),
      },
      body,
    });
    // 202 means Netlify accepted the invocation, not that the job succeeded.
    if (response.status === 202) return true;
    throw new Error(`Background dispatch of ${name} failed: HTTP ${response.status}`);
  } catch (error) {
    await reportError(error, { area: "jobs", step: "dispatch", job: name, jobId: id });
    return false;
  }
}

export interface RunStoredJobOptions {
  db?: typeof prisma;
  now?: () => Date;
  /** Runs the handler (tests swap it). */
  run?: (name: JobName, payload: JobPayload) => Promise<void>;
}

interface ClaimedJob {
  id: number;
  name: string;
  payload: JobPayload;
  attempts: number;
}

/**
 * Runs a saved job once: claims the row (so a duplicate dispatch is a no-op),
 * runs it, and deletes the row. On failure the row goes back to `pending`
 * with a backoff, or to `failed` after MAX_ATTEMPTS, and the error is
 * rethrown so Netlify retries soon. A row that's gone, failed or already
 * running is skipped.
 */
export async function runStoredJob(
  id: number,
  { db = prisma, now = () => new Date(), run = runJob }: RunStoredJobOptions = {},
): Promise<"done" | "skipped"> {
  const at = now();
  const staleBefore = new Date(at.getTime() - STALE_RUNNING_MINUTES * 60_000);
  const [claimed] = await db.$queryRaw<ClaimedJob[]>`
    UPDATE jobs
    SET status = 'running', attempts = attempts + 1, locked_at = ${at}, updated_at = ${at}
    WHERE id = ${id}
      AND (status = 'pending' OR (status = 'running' AND locked_at < ${staleBefore}))
    RETURNING id, name, payload, attempts`;
  if (!claimed) return "skipped";
  if (!isJobName(claimed.name)) {
    await db.job.update({
      where: { id },
      data: { status: "failed", lastError: `Unknown job ${claimed.name}`, lockedAt: null },
    });
    await reportError(new Error(`Unknown job ${claimed.name}`), { area: "jobs", jobId: id });
    return "skipped";
  }

  try {
    await run(claimed.name, claimed.payload);
  } catch (error) {
    const outOfAttempts = claimed.attempts >= MAX_ATTEMPTS;
    const wait = BACKOFF_MINUTES[Math.min(claimed.attempts, BACKOFF_MINUTES.length) - 1];
    await db.job.update({
      where: { id },
      data: {
        status: outOfAttempts ? "failed" : "pending",
        lockedAt: null,
        runAfter: new Date(now().getTime() + wait * 60_000),
        lastError: String((error as Error)?.stack ?? error).slice(0, 4000),
      },
    });
    if (outOfAttempts) {
      await reportError(error, {
        area: "jobs",
        step: "gave up",
        job: claimed.name,
        jobId: id,
        attempts: claimed.attempts,
      });
    }
    throw error;
  }
  // shop/redact deletes the shop's rows itself, so this one may be gone.
  await db.job.deleteMany({ where: { id } });
  return "done";
}

/**
 * Sends again every job that's due: pending past its backoff (and past the
 * grace period its own dispatch gets), or running for longer than a function
 * can. Returns how many it sent. Called every 5 minutes by jobs-sweep.mts.
 */
export async function sweepJobs({
  db = prisma,
  now = new Date(),
  dispatch = dispatchJob,
}: {
  db?: typeof prisma;
  now?: Date;
  dispatch?: (id: number, name: string) => Promise<boolean>;
} = {}): Promise<number> {
  const due = await db.job.findMany({
    where: {
      OR: [
        {
          status: "pending",
          runAfter: { lte: now },
          updatedAt: { lt: new Date(now.getTime() - DISPATCH_GRACE_MINUTES * 60_000) },
        },
        {
          status: "running",
          lockedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MINUTES * 60_000) },
        },
      ],
    },
    select: { id: true, name: true },
    orderBy: { id: "asc" },
    take: SWEEP_BATCH,
  });
  if (due.length === 0) return 0;
  // Restart the grace period, so the next sweep doesn't send them again straight away.
  await db.job.updateMany({
    where: { id: { in: due.map((job) => job.id) }, status: "pending" },
    data: { updatedAt: now },
  });
  await Promise.all(due.map((job) => dispatch(job.id, job.name)));
  return due.length;
}

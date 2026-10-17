/**
 * Saved background jobs (app/lib/background.server.ts): enqueue saves the job
 * and sends only its id; a run claims, runs and deletes it; failures back off
 * and give up after MAX_ATTEMPTS; the sweep sends what's due again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../../app/db.server";
import {
  dispatchJob,
  enqueue,
  MAX_ATTEMPTS,
  runStoredJob,
  sweepJobs,
  verifyJobSignature,
} from "../../../app/lib/background.server";

const t0 = new Date("2026-10-17T12:00:00Z");
const minutes = (n: number) => new Date(t0.getTime() + n * 60_000);

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("enqueue (netlify mode)", () => {
  beforeEach(() => vi.stubEnv("BACKGROUND_DISPATCH", "netlify"));

  it("saves the job and POSTs only its id, signed", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const big = "x".repeat(300_000); // over the background function's 256 KB

    await enqueue("webhook", { topic: "orders/paid", shop: "acme.myshopify.com", payload: { note: big } });

    const [job] = await prisma.job.findMany();
    expect([job.name, job.status, job.shopDomain, job.attempts]).toEqual(["webhook", "pending", "acme.myshopify.com", 0]);
    expect((job.payload as { payload: { note: string } }).payload.note).toHaveLength(300_000);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://shopcare.test/.netlify/functions/jobs-background");
    expect(init.body).toBe(JSON.stringify({ jobId: job.id }));
    expect(verifyJobSignature(init.body as string, (init.headers as Record<string, string>)["x-shopcare-signature"])).toBe(true);
  });

  it("keeps the job for the sweep when Netlify doesn't take it, without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(enqueue("example", {})).resolves.toBeUndefined();
    expect(await prisma.job.count({ where: { status: "pending" } })).toBe(1);
  });

  it("throws when the job can't be saved, so a webhook fails and Shopify retries", async () => {
    vi.spyOn(prisma.job, "create").mockRejectedValueOnce(new Error("db down"));
    await expect(enqueue("example", {})).rejects.toThrow("db down");
  });
});

describe("runStoredJob", () => {
  it("runs the job once and deletes it; a second dispatch is a no-op", async () => {
    const job = await prisma.job.create({ data: { name: "example", payload: { message: "hi" } } });
    const run = vi.fn(async () => {});

    expect(await runStoredJob(job.id, { run, now: () => t0 })).toBe("done");
    expect(await runStoredJob(job.id, { run, now: () => t0 })).toBe("skipped");
    expect(run).toHaveBeenCalledExactlyOnceWith("example", { message: "hi" });
    expect(await prisma.job.count()).toBe(0);
  });

  it("doesn't run a job that's already running", async () => {
    const job = await prisma.job.create({ data: { name: "example", payload: {}, status: "running", lockedAt: t0 } });
    const run = vi.fn(async () => {});
    expect(await runStoredJob(job.id, { run, now: () => minutes(5) })).toBe("skipped");
    expect(run).not.toHaveBeenCalled();
  });

  it("backs off after a failure, rethrows, and gives up after MAX_ATTEMPTS", async () => {
    const job = await prisma.job.create({ data: { name: "example", payload: {} } });
    const run = vi.fn(async () => {
      throw new Error("Shopify is down");
    });

    await expect(runStoredJob(job.id, { run, now: () => t0 })).rejects.toThrow("Shopify is down");
    const first = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect([first.status, first.attempts, first.runAfter, first.lockedAt]).toEqual(["pending", 1, minutes(1), null]);
    expect(first.lastError).toContain("Shopify is down");

    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      await expect(runStoredJob(job.id, { run, now: () => t0 })).rejects.toThrow();
    }
    const last = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect([last.status, last.attempts]).toEqual(["failed", MAX_ATTEMPTS]);
    expect(await runStoredJob(job.id, { run, now: () => t0 })).toBe("skipped");
    expect(run).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it("marks an unknown job failed instead of retrying it", async () => {
    const job = await prisma.job.create({ data: { name: "rm-rf", payload: {} } });
    expect(await runStoredJob(job.id)).toBe("skipped");
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("failed");
  });
});

describe("sweepJobs", () => {
  it("sends due pending jobs and crashed runs again; leaves new, backing-off and failed ones", async () => {
    const make = (data: object) => prisma.job.create({ data: { name: "example", payload: {}, runAfter: minutes(-10), ...data } });
    const lost = await make({ updatedAt: minutes(-10) });
    const crashed = await make({ status: "running", lockedAt: minutes(-25) });
    await make({ updatedAt: t0 }); // just enqueued: its own dispatch is in flight
    await make({ runAfter: minutes(30), updatedAt: minutes(-10) }); // backing off
    await make({ status: "running", lockedAt: minutes(-5) }); // still running
    await make({ status: "failed", updatedAt: minutes(-60) });
    const dispatch = vi.fn<(id: number, name: string) => Promise<boolean>>(async () => true);

    expect(await sweepJobs({ now: t0, dispatch })).toBe(2);
    expect(dispatch.mock.calls.map(([id]) => id).sort()).toEqual([lost.id, crashed.id].sort());

    // Sent again only after another grace period.
    expect(await sweepJobs({ now: minutes(1), dispatch })).toBe(1); // the crashed run is still stale
  });

  it("a stale running job is claimed again", async () => {
    const job = await prisma.job.create({ data: { name: "example", payload: {}, status: "running", lockedAt: minutes(-25), attempts: 1 } });
    const run = vi.fn(async () => {});
    expect(await runStoredJob(job.id, { run, now: () => t0 })).toBe("done");
  });
});

describe("dispatchJob", () => {
  it("reports and returns false when the POST fails", async () => {
    vi.stubEnv("BACKGROUND_DISPATCH", "netlify");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    expect(await dispatchJob(1, "example")).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("step=dispatch"), expect.any(Error));
  });
});

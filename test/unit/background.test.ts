import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enqueue,
  parseEnvelope,
  signJobBody,
  verifyJobSignature,
} from "../../app/lib/background.server";

describe("background job signing", () => {
  const body = JSON.stringify({ job: "example", payload: { message: "hi" } });
  const now = Date.UTC(2026, 9, 16, 12);

  it("accepts its own fresh signature", () => {
    expect(verifyJobSignature(body, signJobBody(body, now), now)).toBe(true);
  });

  it("rejects missing, stale, or mismatched signatures", () => {
    expect(verifyJobSignature(body, null, now)).toBe(false);
    expect(
      verifyJobSignature(body, signJobBody(body, now), now + 6 * 60_000),
    ).toBe(false);
    expect(verifyJobSignature(body + " ", signJobBody(body, now), now)).toBe(
      false,
    );
    expect(verifyJobSignature(body, "garbage", now)).toBe(false);
  });

  it("accepts a saved job's id, or an envelope for a registered job", () => {
    expect(parseEnvelope(JSON.stringify({ jobId: 12 }))).toEqual({ jobId: 12 });
    expect(parseEnvelope(JSON.stringify({ jobId: "12" }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ jobId: -1 }))).toBeNull();
    expect(parseEnvelope(body)).toEqual({
      job: "example",
      payload: { message: "hi" },
    });
    expect(
      parseEnvelope(JSON.stringify({ job: "rm-rf", payload: {} })),
    ).toBeNull();
    expect(
      parseEnvelope(JSON.stringify({ job: "toString", payload: {} })),
    ).toBeNull();
    expect(parseEnvelope("{not json")).toBeNull();
  });
});

describe("enqueue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("runs the job in-process in sync mode (tests)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await enqueue("example", { message: "hello" });
    expect(info).toHaveBeenCalledWith("[job:example] hello");
  });
  // Saving and dispatching (netlify / inline modes): test/integration/wiring/jobs.test.ts
});

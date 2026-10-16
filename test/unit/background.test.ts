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

  it("only accepts envelopes for registered jobs", () => {
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

  it("POSTs a signed envelope to the background function in netlify mode", async () => {
    vi.stubEnv("BACKGROUND_DISPATCH", "netlify");
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await enqueue("example", { message: "hello" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://shopcare.test/.netlify/functions/jobs-background",
    );
    const headers = init.headers as Record<string, string>;
    expect(
      verifyJobSignature(init.body as string, headers["x-shopcare-signature"]),
    ).toBe(true);
  });

  it("throws when Netlify doesn't accept the invocation", async () => {
    vi.stubEnv("BACKGROUND_DISPATCH", "netlify");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await expect(enqueue("example", {})).rejects.toThrow(/HTTP 500/);
  });
});

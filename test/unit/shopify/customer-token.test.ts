/**
 * Ported from Rails test/services/shopify/customer_token_test.rb. ("The key
 * is encrypted at rest" belongs to the Shop model's tests.)
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifiedCustomerId } from "../../../app/shopify/customer-token.server";

const key = "k".repeat(64);
const now = new Date("2026-10-16T12:00:00Z");
const nowTs = Math.floor(now.getTime() / 1000);

// What Liquid renders: customer.id | append: ':' | append: ts | hmac_sha256: key
const sig = (id: string, ts: number, signingKey = key) =>
  createHmac("sha256", signingKey).update(`${id}:${ts}`).digest("hex");

const verify = (
  id: string,
  ts: number,
  signature: string,
  signingKey: string | null = key,
) => verifiedCustomerId(signingKey, id, String(ts), signature, now);

describe("verifiedCustomerId", () => {
  it("a valid token gives the customer id", () => {
    const ts = nowTs - 3600;
    expect(verify("777", ts, sig("777", ts))).toBe("777");
  });

  it("a tampered id, timestamp or signature is rejected", () => {
    const ts = nowTs;
    expect(verify("778", ts, sig("777", ts))).toBeNull();
    expect(verify("777", ts - 1, sig("777", ts))).toBeNull();
    expect(
      verify("777", ts, [...sig("777", ts)].reverse().join("")),
    ).toBeNull();
    expect(verify("777", ts, "")).toBeNull();
    expect(verify("777abc", ts, sig("777abc", ts))).toBeNull();
    expect(verify("777", ts, "not-hex")).toBeNull();
  });

  it("tokens last 24 hours, with a little clock skew", () => {
    const old = nowTs - 24 * 3600 - 1;
    expect(verify("777", old, sig("777", old))).toBeNull();
    const fresh = nowTs - 24 * 3600 + 60;
    expect(verify("777", fresh, sig("777", fresh))).toBe("777");
    const future = nowTs + 10 * 60;
    expect(verify("777", future, sig("777", future))).toBeNull();
  });

  it("a token signed for another shop is rejected", () => {
    const other = "o".repeat(64);
    const ts = nowTs;
    expect(verify("777", ts, sig("777", ts, other))).toBeNull();
    expect(verify("777", ts, sig("777", ts, other), other)).toBe("777");
  });

  it("no key means no customer", () => {
    const ts = nowTs;
    expect(verify("777", ts, sig("777", ts, ""), null)).toBeNull();
    expect(verify("777", ts, sig("777", ts, ""), "")).toBeNull();
  });
});

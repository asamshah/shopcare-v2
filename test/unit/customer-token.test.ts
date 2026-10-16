/**
 * Port of Rails test/services/shopify/customer_token_test.rb. (The "key is
 * encrypted at rest" case belongs with the Shop model port.)
 */
import { describe, expect, it } from "vitest";
import {
  signCustomerToken,
  verifiedCustomerId,
} from "../../app/services/shopify/customer-token.server";

const key = "k".repeat(64);
const now = new Date("2026-10-16T12:00:00Z");
const unix = (d: Date) => Math.floor(d.getTime() / 1000);
const nowTs = unix(now);

// What Liquid renders: customer.id | append: ':' | append: ts | hmac_sha256: key
const sig = (id: string, ts: number, k = key) => signCustomerToken(k, id, ts);
const verify = (
  id: string,
  ts: number,
  signature: string,
  k: string | null = key,
) => verifiedCustomerId(k, id, String(ts), signature, { now });

describe("verifiedCustomerId", () => {
  it("a valid token gives the customer id", () => {
    const ts = nowTs - 3600;
    expect(verify("777", ts, sig("777", ts))).toBe("777");
  });

  it("matches Liquid's hmac_sha256 (lowercase hex of id:ts)", () => {
    expect(sig("777", 1700000000)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a tampered id, timestamp or signature", () => {
    const ts = nowTs;
    const good = sig("777", ts);
    expect(verify("778", ts, good)).toBeNull();
    expect(verify("777", ts - 1, good)).toBeNull();
    expect(verify("777", ts, [...good].reverse().join(""))).toBeNull();
    expect(verify("777", ts, "")).toBeNull();
    expect(verify("777abc", ts, sig("777abc", ts))).toBeNull();
    expect(verify("777", ts, good.toUpperCase())).toBeNull();
    expect(verify("777", ts, `${good}0`)).toBeNull();
    expect(verify("777", ts, `${good}zz`)).toBeNull();
  });

  it("tokens last 24 hours, with a little clock skew", () => {
    const old = nowTs - 24 * 3600 - 1;
    expect(verify("777", old, sig("777", old))).toBeNull();
    const fresh = nowTs - 24 * 3600 + 60;
    expect(verify("777", fresh, sig("777", fresh))).toBe("777");
    const skewed = nowTs + 4 * 60;
    expect(verify("777", skewed, sig("777", skewed))).toBe("777");
    const future = nowTs + 10 * 60;
    expect(verify("777", future, sig("777", future))).toBeNull();
  });

  it("a token signed for another shop is rejected", () => {
    const other = "o".repeat(64);
    expect(verify("777", nowTs, sig("777", nowTs, other))).toBeNull();
    expect(verify("777", nowTs, sig("777", nowTs, other), other)).toBe("777");
  });

  it("no key means no customer", () => {
    expect(verify("777", nowTs, sig("777", nowTs, " "), null)).toBeNull();
    expect(verify("777", nowTs, sig("777", nowTs, " "), "")).toBeNull();
    expect(verify("777", nowTs, sig("777", nowTs, " "), " ")).toBeNull();
  });

  it("missing parts mean no customer", () => {
    expect(
      verifiedCustomerId(key, null, String(nowTs), "x", { now }),
    ).toBeNull();
    expect(verifiedCustomerId(key, "777", undefined, "x", { now })).toBeNull();
    expect(
      verifiedCustomerId(key, "777", String(nowTs), null, { now }),
    ).toBeNull();
  });
});

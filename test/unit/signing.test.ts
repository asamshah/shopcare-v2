import { describe, expect, it } from "vitest";
import { hmacHex, safeEqualHex } from "../../app/lib/signing.server";

describe("safeEqualHex", () => {
  const digest = hmacHex("secret", "data");

  it("accepts the same digest, in either case", () => {
    expect(safeEqualHex(digest, digest)).toBe(true);
    expect(safeEqualHex(digest, digest.toUpperCase())).toBe(true);
  });

  it("rejects trailing junk that Buffer.from(hex) would silently drop", () => {
    expect(safeEqualHex(digest, `${digest}zz`)).toBe(false);
    expect(safeEqualHex(`${digest}zz`, digest)).toBe(false);
    expect(safeEqualHex(`${digest}zz`, `${digest}zz`)).toBe(false);
    expect(safeEqualHex(`${digest.slice(0, -2)}zz`, `${digest.slice(0, -2)}yy`)).toBe(false);
  });

  it("rejects odd lengths, non-hex, empty and length mismatches", () => {
    expect(safeEqualHex(`${digest}0`, `${digest}0`)).toBe(false);
    expect(safeEqualHex("abc", "abc")).toBe(false);
    expect(safeEqualHex("zz", "zz")).toBe(false);
    expect(safeEqualHex("", "")).toBe(false);
    expect(safeEqualHex(digest, digest.slice(0, -2))).toBe(false);
    expect(safeEqualHex(digest, `${digest}00`)).toBe(false);
  });

  it("rejects a different digest of the same length", () => {
    expect(safeEqualHex(digest, hmacHex("secret", "other"))).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(safeEqualHex(digest, undefined as unknown as string)).toBe(false);
  });
});

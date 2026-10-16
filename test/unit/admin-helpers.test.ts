/** Pure helpers behind the admin screens: CSV, display formats, flash URLs, form reading. */
import { describe, expect, it } from "vitest";
import { generateCsv, MalformedCsvError, parseCsv } from "../../app/lib/csv";
import { formatDate, formatDateTime, statusLabel, ticketStatusTone, truncate } from "../../app/lib/format";
import { decimal, formatMoney } from "../../app/lib/format.server";
import { flashUrl } from "../../app/services/admin/flash.server";
import { bool, field, nested, parse, zDecimal, zOptionalId } from "../../app/services/admin/form.server";
import { parseId } from "../../app/services/admin/context.server";

describe("csv", () => {
  it("parses quotes, doubled quotes, CRLF and a chosen separator", () => {
    expect(parseCsv('a,"b,c","d ""e"""\r\n1,2,3\n')).toEqual([["a", "b,c", 'd "e"'], ["1", "2", "3"]]);
    expect(parseCsv("a;b\n1;2", ";")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv('a,"multi\nline"')).toEqual([["a", "multi\nline"]]);
  });

  it("rejects malformed quoting", () => {
    expect(() => parseCsv('"unclosed')).toThrow(MalformedCsvError);
    expect(() => parseCsv('a"b,c')).toThrow(MalformedCsvError);
    expect(() => parseCsv('"a"b,c')).toThrow(MalformedCsvError);
  });

  it("generates what it parses", () => {
    const rows = [["name", "note"], ["Sole", 'says "hi", ok'], ["Glue", null]];
    const text = generateCsv(rows);
    expect(text).toBe('name,note\nSole,"says ""hi"", ok"\nGlue,\n');
    expect(parseCsv(text)).toEqual([["name", "note"], ["Sole", 'says "hi", ok'], ["Glue", ""]]);
  });
});

describe("format", () => {
  it("money like Rails format_money", () => {
    expect(formatMoney("1234.5", "GBP")).toBe("£1,234.50");
    expect(formatMoney(-3, "EUR")).toBe("-€3.00");
    expect(formatMoney("12.5", "CAD")).toBe("12.50 CAD");
    expect(formatMoney(null)).toBe("0.00");
    expect(decimal("12.5000")).toBe("12.5");
  });

  it("labels, tones and dates (UTC)", () => {
    expect(statusLabel("in_repair")).toBe("In repair");
    expect(ticketStatusTone("quote_declined")).toBe("critical");
    const date = new Date(Date.UTC(2026, 9, 5, 9, 7));
    expect([formatDate(date), formatDateTime(date)]).toEqual(["05 Oct 2026", "05 Oct 2026, 09:07"]);
    expect(truncate("x".repeat(100), 80)).toHaveLength(80);
  });
});

describe("flash and forms", () => {
  it("flash rides on the redirect URL and replaces an old one", () => {
    expect(flashUrl("/app/tickets?status=new&notice=old", { notice: "Saved & done" })).toBe(
      "/app/tickets?status=new&notice=Saved+%26+done",
    );
    expect(flashUrl("/app/x", {})).toBe("/app/x");
  });

  it("reads the last value of a hidden-0 + checkbox pair, and nested names", () => {
    const form = new FormData();
    form.append("active", "0");
    form.append("active", "1");
    form.append("values[size]", "UK 7, UK 8");
    form.append("values[colour]", "Black");
    expect(bool(form, "active")).toBe(true);
    expect(field(form, "missing")).toBe("");
    expect(nested(form, "values")).toEqual({ size: "UK 7, UK 8", colour: "Black" });
  });

  it("validates ids and numbers; malformed input is a 400 or 404 response", () => {
    expect(parse(zOptionalId, "")).toBeNull();
    expect(parse(zOptionalId, "12")).toBe(12);
    expect(parse(zDecimal, "£12.50")).toBe("12.50");
    expect(() => parse(zDecimal, "12abc")).toThrow(Response);
    expect(() => parse(zOptionalId, "-1")).toThrow(Response);
    expect(() => parseId("1 OR 1=1")).toThrow(Response);
    expect(() => parseId("99999999999")).toThrow(Response);
    expect(parseId("42")).toBe(42);
  });
});

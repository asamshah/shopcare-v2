import { describe, expect, it } from "vitest";
import { addMonths, longDate } from "../../app/lib/dates";
import { castBoolean, humanize, parameterize, titleize, toSentence } from "../../app/lib/inflections";
import { formatAmount } from "../../app/lib/money";
import { Errors, likePattern, validateNumber } from "../../app/models/validation.server";

describe("model helpers", () => {
  it("adds calendar months like Rails, clamping to the month's end", () => {
    expect(addMonths(new Date("2026-01-31T10:00:00Z"), 1).toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(addMonths(new Date("2024-01-31T00:00:00Z"), 1).toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(addMonths(new Date("2026-03-15T00:00:00Z"), -14).toISOString()).toBe("2025-01-15T00:00:00.000Z");
    expect(longDate(new Date("2026-10-30T23:00:00Z"))).toBe("30 October 2026");
  });

  it("inflects like ActiveSupport for the inputs ShopCare uses", () => {
    expect(humanize("status_change")).toBe("Status change");
    expect(titleize("acme boots")).toBe("Acme Boots");
    expect(parameterize(" Like new! ", "_")).toBe("like_new");
    expect(toSentence(["A", "B", "C"], "or")).toBe("A, B or C");
    expect(toSentence(["A", "B"], "or")).toBe("A or B");
    expect([castBoolean("1"), castBoolean("0"), castBoolean(""), castBoolean(true)]).toEqual([true, false, false, true]);
  });

  it("formats amounts and validates numbers with Rails' messages", () => {
    expect(formatAmount(12.5, "GBP")).toBe("£12.50");
    expect(formatAmount(12.5, "CAD")).toBe("12.50 CAD");
    const errors = new Errors();
    validateNumber(errors, "quantity", "1.5", { onlyInteger: true });
    validateNumber(errors, "price", "abc");
    expect(errors.fullMessages()).toEqual(["Quantity must be an integer", "Price is not a number"]);
    expect(likePattern(" 100%_ ")).toBe("%100\\%\\_%");
  });
});

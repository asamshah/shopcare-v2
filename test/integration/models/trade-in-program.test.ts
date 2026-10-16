// Port of Rails test/models/trade_in_program_test.rb.
import type { Shop } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { addMonths } from "../../../app/lib/dates";
import {
  acceptsAge,
  createTradeInProgram,
  creditFor,
  programGrades,
} from "../../../app/models/trade-in-program.server";
import { ValidationError } from "../../../app/models/validation.server";
import { buildProgram, createShop } from "../../support/factories";

describe("TradeInProgram", () => {
  let shop: Shop;

  beforeEach(async () => {
    shop = await createShop({ shopifyDomain: "tip-test.myshopify.com" });
  });

  it("fixed and percentage credit, with a Care bonus", async () => {
    const fixed = await buildProgram(shop);
    const percent = await buildProgram(shop, { creditMode: "percent", grades: [{ label: "Good", value: 30 }] });

    expect(creditFor(fixed, "good")?.toNumber()).toBe(25);
    expect(creditFor(fixed, "good", { bonusPercent: 10 })?.toNumber()).toBe(27.5);
    expect(creditFor(percent, "good", { paid: 120 })?.toNumber()).toBe(36);
    // percentage credit needs the price paid
    expect(creditFor(percent, "good")).toBeNull();
    expect(creditFor(fixed, "mint")).toBeNull();
  });

  it("grades are normalised and validated", async () => {
    const program = await buildProgram(shop, { grades: [{ label: " Like new ", value: "50" }, { label: "" }] });
    expect(programGrades(program)).toEqual([{ key: "like_new", label: "Like new", description: "", value: 50.0 }]);

    await expect(createTradeInProgram({ shopId: shop.id, name: "X", grades: [] })).rejects.toThrow(ValidationError);
    await expect(
      createTradeInProgram({ shopId: shop.id, name: "X", creditMode: "percent", grades: [{ label: "A", value: 150 }] }),
    ).rejects.toThrow(ValidationError);
  });

  it("maximum age", async () => {
    const program = await buildProgram(shop, { maxAgeMonths: 24 });

    expect(acceptsAge(program, addMonths(new Date(), -12))).toBe(true);
    expect(acceptsAge(program, addMonths(new Date(), -36))).toBe(false);
    expect(acceptsAge(program, null)).toBe(true);
  });
});

// Port of Rails test/models/quotation_line_item_test.rb.
import type { Quotation } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import {
  LINE_ITEM_KINDS,
  lineTotal,
  type QuotationLineItemInput,
  validateQuotationLineItem,
} from "../../../app/models/quotation-line-item.server";
import { createLineItem, createQuotationFor, createRepairTicketFor, createShop } from "../../support/factories";

describe("QuotationLineItem", () => {
  let quotation: Quotation;

  beforeEach(async () => {
    const shop = await createShop({ shopifyDomain: "li-test.myshopify.com" });
    const ticket = await createRepairTicketFor(shop, {
      customerEmail: "c@example.com",
      productTitle: "Boot",
      status: "assessing",
    });
    quotation = await createQuotationFor(ticket.id, { status: "draft", currency: "GBP" });
  });

  const valid = (attrs: Omit<QuotationLineItemInput, "quotationId">) =>
    validateQuotationLineItem(attrs).isEmpty;

  it("lineTotal is qty * unit price minus discount", async () => {
    const line = await createLineItem(quotation.id, { kind: "extra", title: "Part", quantity: 3, unitPrice: 4, discount: 2 });
    expect(lineTotal(line).toNumber()).toBe(10.0); // 3*4 - 2
  });

  it("requires a title and a positive quantity", () => {
    expect(valid({ kind: "extra", title: "", quantity: 1 })).toBe(false);
    expect(valid({ kind: "extra", title: "x", quantity: 0 })).toBe(false);
    expect(valid({ kind: "extra", title: "x", quantity: 1, unitPrice: 1 })).toBe(true);
  });

  it("rejects negative prices, fractional quantities and over-discounting", () => {
    const build = (attrs: Partial<QuotationLineItemInput>) =>
      valid({ kind: "extra", title: "x", quantity: 1, unitPrice: 10, ...attrs });

    expect(build({ unitPrice: -1 })).toBe(false);
    expect(build({ discount: -1 })).toBe(false);
    expect(build({ quantity: 1.5 })).toBe(false);
    expect(build({ discount: 11 })).toBe(false);
    expect(build({ discount: 10 })).toBe(true);
  });

  it("kind enum exposes repair and extra", () => {
    expect(LINE_ITEM_KINDS).toEqual(["repair", "extra"]);
  });
});

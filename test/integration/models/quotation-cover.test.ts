// Port of Rails test/models/quotation_cover_test.rb.
import type { Cover, Quotation } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { addMonths } from "../../../app/lib/dates";
import { createCover, warrantyCoverFor } from "../../../app/models/cover.server";
import { applyCover, coverApplied, linesTotal } from "../../../app/models/quotation.server";
import {
  createItemFor,
  createLineItem,
  createQuotationFor,
  createRepairTicketFor,
  createShop,
  createWarrantyPolicyFor,
} from "../../support/factories";

describe("Quotation cover", () => {
  let cover: Cover;
  let quotation: Quotation;

  beforeEach(async () => {
    const shop = await createShop({ shopifyDomain: "qc-test.myshopify.com" });
    const item = await createItemFor(shop, { productTitle: "Boot", purchasedAt: addMonths(new Date(), -1) });
    const policy = await createWarrantyPolicyFor(shop, {
      name: "Care",
      months: 12,
      outcome: "discount",
      discountPercent: 25,
    });
    cover = await createCover(warrantyCoverFor(item, policy));
    const ticket = await createRepairTicketFor(shop, { customerEmail: "c@example.com", productTitle: "Boot" });
    quotation = await createQuotationFor(ticket.id, { currency: "GBP" });
    await createLineItem(quotation.id, { kind: "repair", title: "Resole", quantity: 1, unitPrice: 40, discount: 0 });
    await createLineItem(quotation.id, { kind: "repair", title: "Heel", quantity: 2, unitPrice: 10, discount: 4 });
  });

  it("cover takes its percentage off the lines total", async () => {
    quotation = await applyCover(quotation.id, cover);

    expect(Number(await linesTotal(quotation.id))).toBe(56);
    expect(Number(quotation.coverDiscount)).toBe(14);
    expect(Number(quotation.subtotal)).toBe(42);
    expect(coverApplied(quotation)).toBe(true);
  });

  it("removing cover charges in full", async () => {
    await applyCover(quotation.id, cover);
    quotation = await applyCover(quotation.id, null);

    expect(Number(quotation.subtotal)).toBe(56);
    expect(coverApplied(quotation)).toBe(false);
  });
});

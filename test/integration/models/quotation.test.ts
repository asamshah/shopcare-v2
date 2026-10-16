// Port of Rails test/models/quotation_test.rb.
import type { Quotation, RepairTicket, Shop } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
import {
  cancelQuotation,
  findByDecisionToken,
  isWarrantyQuote,
  issueDecisionToken,
  QUOTATION_STATUSES,
  recalculateSubtotal,
  reviseQuotation,
  updateQuotation,
} from "../../../app/models/quotation.server";
import { currentQuotation } from "../../../app/models/repair-ticket.server";
import { createLineItem, createQuotationFor, createRepairTicketFor, createShop } from "../../support/factories";

const inAWeek = () => new Date(Date.now() + 7 * 86_400_000);

describe("Quotation", () => {
  let shop: Shop;
  let ticket: RepairTicket;
  let quotation: Quotation;

  beforeEach(async () => {
    shop = await createShop({ shopifyDomain: "q-test.myshopify.com" });
    ticket = await createRepairTicketFor(shop, {
      customerEmail: "c@example.com",
      productTitle: "Boot",
      status: "assessing",
    });
    quotation = await createQuotationFor(ticket.id, { status: "draft", currency: "GBP" });
  });

  it("recalculateSubtotal sums qty * unit price minus discount", async () => {
    await createLineItem(quotation.id, { kind: "repair", title: "Sole", quantity: 2, unitPrice: 10, discount: 3 });
    await createLineItem(quotation.id, { kind: "extra", title: "Part", quantity: 1, unitPrice: 8 });

    quotation = await recalculateSubtotal(quotation.id);

    expect(Number(quotation.subtotal)).toBe(25.0); // (2*10-3) + (1*8-0)
  });

  it("isWarrantyQuote is true only for a zero subtotal", async () => {
    await createLineItem(quotation.id, { kind: "repair", title: "Warranty fix", quantity: 1, unitPrice: 0 });
    quotation = await recalculateSubtotal(quotation.id);
    expect(isWarrantyQuote(quotation)).toBe(true);

    await createLineItem(quotation.id, { kind: "extra", title: "Part", quantity: 1, unitPrice: 5 });
    quotation = await recalculateSubtotal(quotation.id);
    expect(isWarrantyQuote(quotation)).toBe(false);
  });

  it("has a status enum with the expected states", () => {
    expect(QUOTATION_STATUSES).toEqual(["draft", "sent", "paid", "declined", "expired", "cancelled"]);
    expect(quotation.status).toBe("draft");
  });

  it("a decision token is found only in its own shop, and only while it's live", async () => {
    const token = await issueDecisionToken(quotation.id, inAWeek());
    const other = await createShop({ shopifyDomain: "q-other.myshopify.com" });
    // Rails used token.succ; any other token of the same shape will do.
    const altered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");

    expect((await findByDecisionToken(shop.id, token))?.id).toBe(quotation.id);
    expect(await findByDecisionToken(other.id, token)).toBeNull();
    expect(await findByDecisionToken(shop.id, altered)).toBeNull();
    expect(await findByDecisionToken(shop.id, "")).toBeNull();

    await cancelQuotation(quotation.id);
    expect(await findByDecisionToken(shop.id, token)).toBeNull();
  });

  it("revise copies the lines into a new draft and retires a pending quote", async () => {
    await createLineItem(quotation.id, { kind: "extra", title: "Part", quantity: 2, unitPrice: 5, discount: 1 });
    await recalculateSubtotal(quotation.id);
    await updateQuotation(quotation.id, { status: "sent" });
    await issueDecisionToken(quotation.id, inAWeek());

    const revision = (await reviseQuotation(quotation.id))!;

    expect(revision.status).toBe("draft");
    expect(revision.revisedFromId).toBe(quotation.id);
    const lines = await prisma.quotationLineItem.findMany({ where: { quotationId: revision.id } });
    expect(lines.map((l) => [l.title, l.quantity, Number(l.unitPrice), Number(l.discount)])).toEqual([
      ["Part", 2, 5, 1],
    ]);
    expect(Number(revision.subtotal)).toBe(9);
    expect((await currentQuotation(ticket.id))?.id).toBe(revision.id);
    const original = await prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect([original.status, original.decisionTokenDigest]).toEqual(["cancelled", null]);
    // a draft can't be revised
    expect(await reviseQuotation(revision.id)).toBeNull();
  });
});

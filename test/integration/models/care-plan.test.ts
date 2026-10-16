// Port of Rails test/models/care_plan_test.rb.
import type { CarePlan, Shop } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
import { addMonths } from "../../../app/lib/dates";
import {
  badgeLabel,
  carePlanTerms,
  carePlanTermsSnapshot,
  createCarePlan,
  exclusionList,
  STANDARD_EXCLUSIONS,
  termText,
  updateCarePlan,
} from "../../../app/models/care-plan.server";
import {
  careCoverFor,
  claimsCount,
  coverBadgeLabel,
  createCover,
  recordClaim,
} from "../../../app/models/cover.server";
import { applyCover, recalculateSubtotal } from "../../../app/models/quotation.server";
import { ValidationError } from "../../../app/models/validation.server";
import {
  buildCare,
  createItemFor,
  createLineItem,
  createQuotationFor,
  createRepairTicketFor,
  createShop,
  daysAgo,
} from "../../support/factories";

describe("CarePlan", () => {
  let shop: Shop;
  let care: Awaited<ReturnType<typeof buildCare>>;
  let plan: CarePlan;

  beforeEach(async () => {
    shop = await createShop({ shopifyDomain: "careplan-test.myshopify.com" });
    care = await buildCare(shop);
    plan = care.plan;
  });

  it("every plan carries the fixed exclusions", async () => {
    plan = await updateCarePlan(plan.id, { exclusions: "Suede wear\n" });

    expect(exclusionList(plan)).toEqual([...STANDARD_EXCLUSIONS, "Suede wear"]);
    expect(carePlanTermsSnapshot(plan).exclusions).toEqual(exclusionList(plan));
  });

  it("generated terms: all repairs for the term except the exclusions, excess, perk and statutory rights", async () => {
    plan = await updateCarePlan(plan.id, {
      excess: 4.5,
      perks: { priority: "1" },
      exclusions: "Wear to suede uppers",
    });

    expect(carePlanTerms(plan, { currency: "GBP", product: "Aria Boot" })).toEqual([
      "All repairs to your Aria Boot for 2 years, except: theft or loss; accidental damage; deliberate damage or misuse; " +
        "cash payouts: claims are honoured by repair or replacement only; wear to suede uppers.",
      "An excess of £4.50 applies to each repair.",
      "Your repairs get priority turnaround.",
      "This plan is in addition to, and does not affect, your statutory rights.",
    ]);
    expect(carePlanTermsSnapshot(plan, { product: "Aria Boot" }).terms).toEqual(
      carePlanTerms(plan, { product: "Aria Boot" }),
    );
  });

  it("terms without a product or extras keep the fixed text, in months when not whole years", async () => {
    plan = await updateCarePlan(plan.id, { termMonths: 18 });
    const terms = carePlanTerms(plan);

    expect(terms).toHaveLength(2);
    expect(terms[0]).toMatch(/^All repairs to your item for 18 months, except: theft or loss;/);
    expect(terms[terms.length - 1]).toBe(
      "This plan is in addition to, and does not affect, your statutory rights.",
    );
    expect([12, 24, 18].map((months) => termText(months))).toEqual(["1 year", "2 years", "18 months"]);
  });

  it("badge: the brand and the term, in months when not whole years", async () => {
    expect(badgeLabel(plan.termMonths)).toBe("ShopCare – 2 year plan");
    expect([12, 18].map(badgeLabel)).toEqual(["ShopCare – 1 year plan", "ShopCare – 18 month plan"]);
    const item = await createItemFor(shop, { productTitle: "Boot", purchasedAt: daysAgo(1) });
    expect(coverBadgeLabel(careCoverFor(item, plan))).toBe("ShopCare – 2 year plan");
  });

  it("perks are normalised", async () => {
    plan = await updateCarePlan(plan.id, {
      perks: { priority: "1", trade_in_bonus_percent: "10", non_covered_discount_percent: "15" },
    });

    expect(plan.perks).toEqual({ priority: true, trade_in_bonus_percent: 10.0 });
    await expect(updateCarePlan(plan.id, { perks: { trade_in_bonus_percent: 120 } })).rejects.toThrow(
      ValidationError,
    );
  });

  it("a Care product can only back one plan", async () => {
    await expect(
      createCarePlan({ shopId: shop.id, name: "Other", shopifyVariantId: "7001" }),
    ).rejects.toThrow(/is already linked to another Care plan/);
  });

  it("Care cover: every line free, excess once per repair, claims counted", async () => {
    plan = await updateCarePlan(plan.id, { excess: 5 });
    const item = await createItemFor(shop, { productTitle: "Boot", purchasedAt: addMonths(new Date(), -1) });
    const cover = await createCover(careCoverFor(item, plan));
    const ticket = await createRepairTicketFor(shop, { customerEmail: null, productTitle: "Boot" });
    const quote = await createQuotationFor(ticket.id, { currency: "GBP" });
    await createLineItem(quote.id, { kind: "repair", title: "Resole", unitPrice: 60, shopifyVariantId: "900" });
    await createLineItem(quote.id, { kind: "repair", title: "Heel", unitPrice: 20, shopifyVariantId: "901" });
    await createLineItem(quote.id, { kind: "extra", title: "Laces", unitPrice: 3 });

    let q = await applyCover(quote.id, cover);
    expect([q.coverDiscount, q.coverExcess, q.subtotal].map(Number)).toEqual([83, 5, 5]);

    await recordClaim(cover.id);
    await recordClaim(cover.id);
    q = await recalculateSubtotal(quote.id);
    // no limits to use up
    expect([q.coverDiscount, q.coverExcess, q.subtotal].map(Number)).toEqual([83, 5, 5]);
    const reloaded = await prisma.cover.findUniqueOrThrow({ where: { id: cover.id } });
    expect(claimsCount(reloaded)).toBe(2);
    expect((reloaded.terms as { terms: string[] }).terms[0]).toContain(
      "All repairs to your Boot for 2 years",
    );
  });

  it("a Care cover sold with per-service terms is honoured as full repair cover", async () => {
    const item = await createItemFor(shop, { productTitle: "Boot", purchasedAt: addMonths(new Date(), -1) });
    let cover = await createCover(careCoverFor(item, plan));
    cover = await prisma.cover.update({
      where: { id: cover.id },
      data: {
        terms: {
          ...(cover.terms as object),
          covers_all_services: false,
          covered_service_ids: [care.resole.id],
          limits: [{ repair_service_id: care.resole.id, max: 1, per_months: 12 }],
        },
      },
    });
    const ticket = await createRepairTicketFor(shop, { customerEmail: null, productTitle: "Boot" });
    const quote = await createQuotationFor(ticket.id, { currency: "GBP" });
    await createLineItem(quote.id, { kind: "repair", title: "Heel", unitPrice: 20, shopifyVariantId: "901" });

    const q = await applyCover(quote.id, cover);
    expect(Number(q.subtotal)).toBe(0);
  });
});
